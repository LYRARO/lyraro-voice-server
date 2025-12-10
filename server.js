import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get('/', (req, res) => res.send('LYRARO Voice Server Running'));

app.post('/voice', (req, res) => {
  const { systemPrompt, greeting } = req.query;
  const wsUrl = `wss://${req.get('host')}/media-stream?systemPrompt=${encodeURIComponent(systemPrompt || '')}&greeting=${encodeURIComponent(greeting || '')}`;
  
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="${wsUrl}" />
      </Connect>
    </Response>`);
});

wss.on('connection', async (twilioWs, req) => {
  console.log('Twilio connected');
  
  const url = new URL(req.url, `wss://${req.headers.host}`);
  const systemPrompt = decodeURIComponent(url.searchParams.get('systemPrompt') || '');
  const greeting = decodeURIComponent(url.searchParams.get('greeting') || '');
  
  let streamSid = null;
  
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI');
    
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: systemPrompt || 'Du bist ein freundlicher Telefonassistent.',
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
      }
    }));
    
    if (greeting) {
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: greeting }] }
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  });

  openaiWs.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (event.type === 'response.audio.delta' && event.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
    }
  });

  twilioWs.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === 'start') streamSid = data.start.streamSid;
    if (data.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
    }
    if (data.event === 'stop') openaiWs?.close();
  });

  twilioWs.on('close', () => openaiWs?.close());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
