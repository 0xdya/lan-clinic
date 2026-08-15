/**
 * index.js - Express + Socket.io Server
 * This file is spawned as a child process by the Electron main process (via fork()).
 *
 * Responsibilities:
 *   - Bind Express REST API to 0.0.0.0:3000
 *   - Attach Socket.io for real-time LAN sync
 *   - Notify parent process when ready (process.send)
 *
 * Socket.io Events Emitted by Server:
 *   - queue:updated        → Broadcasted to all clients when queue changes
 *   - notes:updated        → Broadcasted to all clients when doctor notes change
 *
 * Socket.io Events Received by Server:
 *   - client:queue-change  → Secretary triggers queue status change
 *   - client:notes-change  → Doctor saves notes
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');
const path = require('path');

// ── Database & Routes ─────────────────────────
// initialize() must be awaited before handling requests
const { initialize: initDb } = require('./database');
const patientsRouter = require('./routes/patients');
const queueRouter = require('./routes/queue');

// ─────────────────────────────────────────────
// Express App Setup
// ─────────────────────────────────────────────
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// REST API Routes
app.use('/api/patients', patientsRouter);
app.use('/api/queue', queueRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found.' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// ─────────────────────────────────────────────
// HTTP Server + Socket.io
// ─────────────────────────────────────────────
const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  },
  // Ping settings for LAN reliability
  pingTimeout: 10000,
  pingInterval: 5000,
});

// ─────────────────────────────────────────────
// Socket.io Event Handling
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id} from ${socket.handshake.address}`);

  // ── Queue changed (Secretary triggers) ──────
  socket.on('client:queue-change', (data) => {
    // Broadcast to ALL clients (including Doctor's screen)
    io.emit('queue:updated', data);
    console.log(`[Socket] queue:updated broadcast from ${socket.id}`, data);
  });

  // ── Notes changed (Doctor triggers) ─────────
  socket.on('client:notes-change', (data) => {
    // Broadcast to ALL clients
    io.emit('notes:updated', data);
    console.log(`[Socket] notes:updated broadcast from ${socket.id}`);
  });

  // ── Generic refresh request ──────────────────
  socket.on('client:request-refresh', () => {
    io.emit('queue:updated', { refresh: true });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Socket] Client disconnected: ${socket.id} — reason: ${reason}`);
  });

  socket.on('error', (err) => {
    console.error(`[Socket] Error on ${socket.id}:`, err);
  });
});

// ─────────────────────────────────────────────
// Async Bootstrap — init DB first, then start HTTP server
// ─────────────────────────────────────────────
(async () => {
  try {
    await initDb();
    console.log('[Server] Database initialized.');

    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] LAN Clinic API listening on 0.0.0.0:${PORT}`);
      console.log(`[Server] Endpoints: GET /health  |  /api/patients  |  /api/queue`);

      // Notify Electron main process that the server is ready
      if (process.send) {
        process.send({ type: 'SERVER_READY', port: PORT });
      }
    });

    httpServer.on('error', (err) => {
      console.error('[Server] HTTP server error:', err);
      if (process.send) {
        process.send({ type: 'SERVER_ERROR', error: err.message });
      }
      process.exit(1);
    });
  } catch (err) {
    console.error('[Server] Fatal startup error:', err);
    if (process.send) {
      process.send({ type: 'SERVER_ERROR', error: err.message });
    }
    process.exit(1);
  }
})();
