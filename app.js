// javascript
//
// This script connects to the OpenAI Realtime API to create a voice-based assistant.
//
// It captures audio input from your microphone, sends it to the OpenAI API for processing,
// and plays back the assistant's audio response through your speakers.
//
// **How to Run on a Mac:**
//
// 1. **Install Dependencies:**
//    - Ensure you have Node.js and npm installed.
//    - Run `npm init & npm install` to install all required packages.
//
// 2. **Set Up Environment Variables:**
//    - Create a `.env` file in the same directory as this script.
//    - Add your OpenAI API key to the `.env` file:
//      ```
//      OPENAI_API_KEY=your_api_key_here
//      ```
//
// 3. **Run the Script:**
//    - Execute the script with the command `node node_devenv.mjs`.
//
// **Note:** Make sure your microphone and speakers are properly configured and accessible on your Mac.
//

import { RealtimeClient } from '@openai/realtime-api-beta';
import mic from 'mic';
import { Readable } from 'stream';
import Speaker from 'speaker';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Set up __dirname equivalent for ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/api/socket.io/',
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 3000;

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Add this line to serve files from the views directory
app.use('/views', express.static(path.join(__dirname, 'views')));

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Update the 404 handler to handle missing file more gracefully
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'views', '404.html'), (err) => {
    if (err) {
      console.error('Error sending 404 page:', err);
      res.status(404).send('404 - Page Not Found');
    }
  });
});

const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error(
    'Please set your OPENAI_API_KEY in your environment variables.',
  );
  process.exit(1);
}

const client = new RealtimeClient({
  apiKey: API_KEY,
  model: 'gpt-4o-realtime-preview-2024-10-01',
});

let micInstance;
let speaker;
let activeConnections = new Set();
let isClientConnected = false;

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected');
  activeConnections.add(socket);

  socket.on('startStream', async () => {
    try {
      if (!isClientConnected) {
        console.log('Connecting to OpenAI...');
        await client.connect();
        isClientConnected = true;
        console.log('Connected to OpenAI successfully');
      }
      startAudioStream(socket);
      socket.emit('streamStarted');
    } catch (error) {
      console.error('Error connecting to OpenAI Realtime API:', error);
      socket.emit('error', 'Failed to start stream');
    }
  });

  socket.on('audioData', async (data) => {
    try {
      if (!isClientConnected) {
        console.log('Reconnecting to OpenAI...');
        await client.connect();
        isClientConnected = true;
      }

      const buffer = Buffer.from(data);
      const int16Array = new Int16Array(buffer.buffer);
      await client.appendInputAudio(int16Array);
    } catch (error) {
      console.error('Error processing audio data:', error);
      if (error.message.includes('not connected')) {
        isClientConnected = false;
        socket.emit('error', 'Connection lost. Please try again.');
      }
    }
  });

  socket.on('createResponse', async () => {
    try {
      if (!isClientConnected) {
        await client.connect();
        isClientConnected = true;
      }
      console.log('Creating response...');
      await client.createResponse();
    } catch (error) {
      console.error('Error creating response:', error);
      socket.emit('error', 'Failed to create response');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
    activeConnections.delete(socket);
    if (activeConnections.size === 0) {
      isClientConnected = false;
      client.disconnect().catch(console.error);
    }
  });
});

// Handle client events with better logging
client.on('conversation.item.completed', ({ item }) => {
  console.log('Conversation item completed:', item);

  if (
    item.type === 'message' &&
    item.role === 'assistant' &&
    item.formatted &&
    item.formatted.audio
  ) {
    const audioData = item.formatted.audio;

    // Debug logging
    console.log('Audio data received:', {
      type: typeof audioData,
      length: audioData.length,
      isArray: Array.isArray(audioData),
      isTypedArray: audioData instanceof Int16Array,
    });

    if (audioData && audioData.length > 0) {
      // Ensure we're sending a proper Int16Array
      const audioArray =
        audioData instanceof Int16Array ? audioData : new Int16Array(audioData);

      console.log(
        'Sending audio response to clients, length:',
        audioArray.length,
      );
      io.emit('audioResponse', Array.from(audioArray)); // Convert to regular array for transmission
    } else {
      console.error('Invalid audio data received from OpenAI');
      io.emit('error', 'Invalid audio response received');
    }
  } else {
    console.log('No audio in response:', item);
  }
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});

// BEGIN MANAGE Mac AUDIO INTERFACES

function startAudioStream(socket) {
  try {
    micInstance = mic({
      rate: '24000',
      channels: '1',
      debug: false,
      exitOnSilence: 6,
      fileType: 'raw',
      encoding: 'signed-integer',
    });

    const micInputStream = micInstance.getAudioStream();

    micInputStream.on('error', (error) => {
      console.error('Microphone error:', error);
    });

    micInstance.start();
    console.log('Microphone started streaming.');

    let audioBuffer = Buffer.alloc(0);
    const chunkSize = 4800; // 0.2 seconds of audio at 24kHz

    micInputStream.on('data', (data) => {
      audioBuffer = Buffer.concat([audioBuffer, data]);

      while (audioBuffer.length >= chunkSize) {
        const chunk = audioBuffer.slice(0, chunkSize);
        audioBuffer = audioBuffer.slice(chunkSize);

        const int16Array = new Int16Array(
          chunk.buffer,
          chunk.byteOffset,
          chunk.length / 2,
        );

        try {
          client.appendInputAudio(int16Array);
        } catch (error) {
          console.error('Error sending audio data:', error);
        }
      }
    });

    micInputStream.on('silence', () => {
      console.log('Silence detected, creating response...');
      try {
        client.createResponse();
      } catch (error) {
        console.error('Error creating response:', error);
      }
    });
  } catch (error) {
    console.error('Error starting audio stream:', error);
  }
}

function playAudio(audioData) {
  try {
    if (!speaker) {
      speaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: 24000,
      });
    }

    // Convert Int16Array to Buffer
    const buffer = Buffer.from(audioData.buffer);

    // Create a readable stream from the buffer
    const readableStream = new Readable({
      read() {
        this.push(buffer);
        this.push(null);
      },
    });

    // Pipe the stream to the speaker
    readableStream.pipe(speaker);
    console.log(
      'Audio sent to speaker for playback. Buffer length:',
      buffer.length,
    );

    // Handle the 'close' event to recreate the speaker for the next playback
    speaker.on('close', () => {
      console.log('Speaker closed. Recreating for next playback.');
      speaker = null;
    });
  } catch (error) {
    console.error('Error playing audio:', error);
  }
}

// END MANAGE AUDIO INTERFACES
