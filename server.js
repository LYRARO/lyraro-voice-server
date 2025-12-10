// server.js
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const url = require('url');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is not set');
}

const app = express();

// Twilio sendet standardmäßig x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Simple Health Check
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// Hilfsfunktion: XML escapen für TwiML
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Twilio Voice Webhook – gibt TwiML mit <Connect><Stream> zurück
app.post('/voice', (req, res) => {
  try {
    // systemPrompt & greeting kommen als URL-Parameter im Twilio Webhook
    const systemPrompt =
      (req.query.systemPrompt && String(req.query.systemPrompt)) ||
      'Du bist ein hilfreicher, professioneller Telefonassistent für einen Handwerksbetrieb. Sprich freundlich, klar und strukturiert.';
    const greeting =
      (req.query.greeting && String(req.query.greeting)) ||
      'Hallo, hier ist der digitale Assistent. Wie kann ich Ihnen weiterhelfen?';

    // Host / Protokoll aus Request ermitteln (Railway hinter Proxy)
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const wsProto = proto === 'https' ? 'wss' : 'ws';

    const wsUrl =
      `${wsProto}://${host}/media-stream` +
      `?systemPrompt=${encodeURIComponent(systemPrompt)}` +
      `&greeting=${encodeURIComponent(greeting)}`;

    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<Connect>` +
      `<Stream url="${escapeXml(wsUrl)}" />` +
      `</Connect>` +
      `</Response>`;

    res
      .status(200)
      .type('text/xml')
      .send(twiml);
  } catch (err) {
    console.error('Error in /voice handler', err);
    res.status(500).send('Internal Server Error');
  }
});

// HTTP-Server + WebSocket-Server aufsetzen
const server = http.createServer(app);

// WebSocket-Server für Twilio Media Streams
const wss = new WebSocket.Server({ server, path: '/media-stream' });

// Helper zum Senden eines Realtime-Events (JSONL)
function sendOpenAIEvent(openaiWs, event) {
  if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
  try {
    openaiWs.send(JSON.stringify(event));
  } catch (err) {
    console.error('Error sending event to OpenAI WS', err);
  }
}

wss.on('connection', (twilioWs, req) => {
  console.log('Twilio WebSocket connected');

  if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY, closing Twilio socket');
    twilioWs.close();
    return;
  }

  // Query-Parameter aus WS-URL auslesen (systemPrompt & greeting)
  const parsedUrl = url.parse(req.url, true);
  const systemPrompt =
    (parsedUrl.query.systemPrompt && String(parsedUrl.query.systemPrompt)) ||
    'Du bist ein hilfreicher, professioneller Telefonassistent für einen Handwerksbetrieb. Sprich freundlich, klar und strukturiert.';
  const greeting =
    (parsedUrl.query.greeting && String(parsedUrl.query.greeting)) ||
    'Hallo, hier ist der digitale Assistent. Wie kann ich Ihnen weiterhelfen?';

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;

  // Verbindung zur OpenAI Realtime API aufbauen
  const openaiUrl =
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

  openaiWs = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      // Für ältere Beta-Versionen wäre ggf. nötig:
      // 'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime API');
    openaiReady = true;

    // Session konfigurieren: Audio-Settings + System Prompt
    // g711_ulaw I/O, Voice alloy, Audio/Text Modalitäten
    sendOpenAIEvent(openaiWs, {
      type: 'session.update',
      session: {
        type: 'realtime',
        modalities: ['audio', 'text'],
        instructions: systemPrompt,
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // Turn Detection über Server-VAD (Standard), kann man hier explizit setzen:
        // turn_detection: {
        //   type: 'server_vad',
        //   threshold: 0.5,
        //   prefix_padding_ms: 300,
        //   silence_duration_ms: 200,
        //   create_response: true
        // }
      }
    });

    // Greeting als conversation.item.create + response.create
    if (greeting && greeting.trim().length > 0) {
      // Greeting als "User-Item" – Modell soll darauf mit Audio antworten
      sendOpenAIEvent(openaiWs, {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: greeting }
          ]
        }
      });

      // Direkte Antwort des Modells triggern (Audio-Gruß)
      sendOpenAIEvent(openaiWs, {
        type: 'response.create',
        // Optional: Spezifische Response-Konfig, hier nicht nötig
      });
    }
  });

  openaiWs.on('error', (err) => {
    console.error('OpenAI WS error:', err);
  });

  openaiWs.on('close', (code, reason) => {
    console.log('OpenAI WS closed:', code, reason && reason.toString());
    // Twilio-Verbindung ebenfalls sauber schließen
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }
  });

  // Events von OpenAI → zurück an Twilio streamen
  openaiWs.on('message', (data) => {
    // Realtime API sendet JSON-Events, teilweise JSONL
    let text = data.toString();
    const lines = text.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        console.error('Failed to parse OpenAI event:', err);
        continue;
      }

      const type = event.type;

      // Audio-Ausgabe-Event:
      // Aktuell: response.output_audio.delta
      // Ältere Beta: response.audio.delta (Fallback)
      if (
        type === 'response.output_audio.delta' ||
        type === 'response.audio.delta'
      ) {
        const audioDelta = event.delta; // base64-encoded g711_ulaw
        if (!audioDelta) continue;
        if (!streamSid) {
          // Ohne streamSid können wir nicht sauber zurücksenden
          continue;
        }

        if (twilioWs.readyState === WebSocket.OPEN) {
          const twilioMediaMsg = {
            event: 'media',
            streamSid: streamSid,
            media: {
              payload: audioDelta
            }
          };
          try {
            twilioWs.send(JSON.stringify(twilioMediaMsg));
          } catch (err) {
            console.error('Error sending media back to Twilio:', err);
          }
        }
      }

      // Optional: Logging von Errors
      if (type === 'error') {
        console.error('OpenAI Realtime error event:', event);
      }
    }
  });

  // Events von Twilio → an OpenAI weiterreichen
  twilioWs.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (err) {
      console.error('Failed to parse Twilio message:', err);
      return;
    }

    const eventType = data.event;

    switch (eventType) {
      case 'start':
        streamSid = data.start && data.start.streamSid;
        console.log('Twilio stream started, streamSid:', streamSid);
        break;

      case 'media':
        // Twilio media payload: base64 g711_ulaw @ 8kHz mono
        if (!openaiReady || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
          return;
        }
        if (!data.media || !data.media.payload) {
          return;
        }
        sendOpenAIEvent(openaiWs, {
          type: 'input_audio_buffer.append',
          audio: data.media.payload // direkt durchreichen
        });
        break;

      case 'mark':
        // Kann ignoriert oder fürs Logging genutzt werden
        // console.log('Twilio mark event:', data);
        break;

      case 'stop':
        console.log('Twilio stream stopped');
        // Call ist vorbei – beide Seiten schließen
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.close();
        }
        break;

      default:
        // Unbekannte Events nur loggen
        // console.log('Unhandled Twilio event:', eventType);
        break;
    }
  });

  twilioWs.on('close', (code, reason) => {
    console.log('Twilio WS closed:', code, reason && reason.toString());
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WS error:', err);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
});

// Railway-Port & 0.0.0.0 Binding
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
