// server.js - LYRARO Voice Server für Railway + Twilio + OpenAI Realtime
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Middleware für Twilio (x-www-form-urlencoded) & JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'lyraro-voice-server' });
});

// Voice endpoint – Twilio Webhook, gibt TwiML mit <Connect><Stream> zurück
app.post('/voice', (req, res) => {
  const systemPrompt =
    req.query.systemPrompt ||
    'Du bist ein freundlicher, professioneller Telefonassistent für einen Handwerksbetrieb. Sprich klar, strukturiert und höflich.';
  const greeting =
    req.query.greeting ||
    'Hallo, hier ist der digitale Assistent. Wie kann ich Ihnen weiterhelfen?';

  const host = req.get('host');
  const wsUrl =
    `wss://${host}/media-stream` +
    `?systemPrompt=${encodeURIComponent(systemPrompt)}` +
    `&greeting=${encodeURIComponent(greeting)}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}"></Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

// WebSocket-Server für Twilio Media Streams
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (twilioWs, req) => {
  console.log('Twilio WebSocket connected');

  if (!OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY not set, closing connection');
    twilioWs.close();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const systemPrompt =
    urlObj.searchParams.get('systemPrompt') ||
    'Du bist ein freundlicher, professioneller Telefonassistent für einen Handwerksbetrieb. Sprich klar, strukturiert und höflich.';
  const greeting =
    urlObj.searchParams.get('greeting') ||
    'Hallo, hier ist der digitale Assistent. Wie kann ich Ihnen weiterhelfen?';

  let openaiWs = null;
  let streamSid = null;
  let sessionReady = false;

  // Verbindung zur OpenAI Realtime API aufbauen
  const connectOpenAI = () => {
    console.log('Connecting to OpenAI Realtime API...');
    openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

    openaiWs.on('open', () => {
      console.log('OpenAI WS connection established (waiting for session.created)');
    });

    openaiWs.on('message', (data) => {
      const text = data.toString();
      // Realtime kann JSONL schicken, daher Zeilenweise parsen
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch (err) {
          console.error('Failed to parse OpenAI event:', err, 'Raw:', line);
          continue;
        }

        const type = event.type;
        // console.log('OpenAI event:', type);

        // Session initialisiert – jetzt konfigurieren
        if (type === 'session.created') {
          console.log('OpenAI session.created – sending session.update');

          const sessionUpdate = {
            type: 'session.update',
            session: {
              // nur erlaubte Felder laut Realtime Beta
              voice: 'alloy',
              instructions: systemPrompt,
              modalities: ['audio', 'text'],
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              input_audio_transcription: {
                model: 'whisper-1',
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
          };

          openaiWs.send(JSON.stringify(sessionUpdate));
        }

        // Session erfolgreich aktualisiert – jetzt Greeting schicken
        if (type === 'session.updated') {
          console.log('OpenAI session.updated – session ready');
          sessionReady = true;

          if (greeting && greeting.trim().length > 0) {
            console.log('Sending greeting to model');

            // Greeting als User-Eingabe, damit das Modell eine Audio-Antwort erzeugt
            const greetingEvent = {
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: greeting,
                  },
                ],
              },
            };

            openaiWs.send(JSON.stringify(greetingEvent));
            openaiWs.send(JSON.stringify({ type: 'response.create' }));
          }
        }

        // Audio-Delta von OpenAI -> zurück an Twilio streamen
        if (
          (type === 'response.audio.delta' ||
            type === 'response.output_audio.delta') &&
          event.delta &&
          streamSid &&
          twilioWs.readyState === WebSocket.OPEN
        ) {
          const audioPayload = event.delta; // base64 g711_ulaw
          const audioMessage = {
            event: 'media',
            streamSid,
            media: {
              payload: audioPayload,
            },
          };

          try {
            twilioWs.send(JSON.stringify(audioMessage));
          } catch (err) {
            console.error('Error sending audio to Twilio:', err);
          }
        }

        if (type === 'error') {
          console.error('OpenAI Realtime error event:', JSON.stringify(event, null, 2));
        }
      }
    });

    openaiWs.on('error', (error) => {
      console.error('OpenAI WebSocket error:', error);
    });

    openaiWs.on('close', (code, reason) => {
      console.log('OpenAI WS closed:', code, reason && reason.toString());
    });
  };

  // Twilio Messages -> OpenAI weiterleiten
  twilioWs.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (error) {
      console.error('Error parsing Twilio message JSON:', error, 'Raw:', message.toString());
      return;
    }

    const eventType = data.event;

    if (eventType === 'start') {
      streamSid = data.start && data.start.streamSid;
      console.log('Twilio stream started, streamSid:', streamSid);
      connectOpenAI();
      return;
    }

    if (
      eventType === 'media' &&
      openaiWs &&
      openaiWs.readyState === WebSocket.OPEN &&
      sessionReady
    ) {
      if (!data.media || !data.media.payload) return;

      const audioAppend = {
        type: 'input_audio_buffer.append',
        audio: data.media.payload, // base64 g711_ulaw
      };
      openaiWs.send(JSON.stringify(audioAppend));
      return;
    }

    if (eventType === 'stop') {
      console.log('Twilio stream stopped');
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.close();
      }
      return;
    }

    // andere Events kannst du bei Bedarf loggen
    // console.log('Unhandled Twilio event:', eventType);
  });

  twilioWs.on('close', (code, reason) => {
    console.log('Twilio WS closed:', code, reason && reason.toString());
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (error) => {
    console.error('Twilio WebSocket error:', error);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
