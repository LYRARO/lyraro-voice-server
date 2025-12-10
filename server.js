import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Health check endpoint
app.get('/', (req, res) => {
  res.send('LYRARO Voice Server Running');
});

// Twilio Voice webhook - returns TwiML to connect to WebSocket
app.post('/voice', (req, res) => {
  const systemPrompt = req.query.systemPrompt || '';
  const greeting = req.query.greeting || '';
  
  const host = req.get('host');
  const wsUrl = `wss://${host}/media-stream?systemPrompt=${encodeURIComponent(systemPrompt)}&greeting=${encodeURIComponent(greeting)}`;
  
  console.log('Voice webhook called, WebSocket URL:', wsUrl);
  
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
});

// WebSocket handler for Twilio Media Stream
wss.on('connection', async (twilioWs, req) => {
  console.log('=== NEW TWILIO CONNECTION ===');
  
  const url = new URL(req.url, `wss://${req.headers.host}`);
  const systemPrompt = decodeURIComponent(url.searchParams.get('systemPrompt') || '');
  const greeting = decodeURIComponent(url.searchParams.get('greeting') || '');
  
  console.log('System prompt length:', systemPrompt.length);
  console.log('Greeting:', greeting);
  
  let streamSid = null;
  let openaiWs = null;
  
  // Connect to OpenAI Realtime API
  try {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
  } catch (error) {
    console.error('Failed to create OpenAI WebSocket:', error);
    twilioWs.close();
    return;
  }

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');
    
    // Configure session
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: systemPrompt || 'Du bist ein freundlicher Telefonassistent für einen deutschen Handwerksbetrieb.',
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    }));
    
    // Send greeting if provided
    if (greeting) {
      console.log('Sending greeting to OpenAI');
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: greeting }]
        }
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  });

  openaiWs.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      
      // Forward audio to Twilio
      if (event.type === 'response.audio.delta' && event.delta && streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: event.delta }
        }));
      }
      
      // Log important events
      if (event.type === 'session.created') {
        console.log('OpenAI session created');
      }
      if (event.type === 'session.updated') {
        console.log('OpenAI session configured');
      }
      if (event.type === 'response.audio_transcript.done') {
        console.log('AI said:', event.transcript);
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        console.log('User said:', event.transcript);
      }
      if (event.type === 'error') {
        console.error('OpenAI error:', event.error);
      }
    } catch (error) {
      console.error('Error processing OpenAI message:', error);
    }
  });

  openaiWs.on('error', (error) => {
    console.error('OpenAI WebSocket error:', error);
  });

  openaiWs.on('close', (code, reason) => {
    console.log('OpenAI connection closed:', code, reason.toString());
  });

  // Handle Twilio messages
  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log('Twilio stream started:', streamSid);
      }
      
      if (data.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: data.media.payload
        }));
      }
      
      if (data.event === 'stop') {
        console.log('Twilio stream stopped');
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
      }
    } catch (error) {
      console.error('Error processing Twilio message:', error);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio connection closed');
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (error) => {
    console.error('Twilio WebSocket error:', error);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`LYRARO Voice Server running on port ${PORT}`);
  console.log(`OpenAI API Key configured: ${OPENAI_API_KEY ? 'Yes' : 'NO - MISSING!'}`);
});
