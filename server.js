const express = require('express');
const http = require('http');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const SERIAL_PATH = '/dev/ttyACM0';  // STM32 USB CDC Virtual COM Port
const BAUD_RATE = 115200;
const LOG_FILE = path.join(__dirname, 'session_log.csv');

// --- Ensure log file has a header ---
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'timestamp,name,pressure_psi,stm32_response\n');
}

// --- Serial Port Setup ---
let serialPort;
let parser;

function initSerial() {
  try {
    serialPort = new SerialPort({
      path: SERIAL_PATH,
      baudRate: BAUD_RATE,
      autoOpen: false,
    });

    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

    serialPort.open((err) => {
      if (err) {
        console.error(`[SERIAL] Failed to open ${SERIAL_PATH}: ${err.message}`);
        io.emit('serial_status', { connected: false, message: err.message });
      } else {
        console.log(`[SERIAL] Connected on ${SERIAL_PATH} at ${BAUD_RATE} baud`);
        io.emit('serial_status', { connected: true, message: `Connected on ${SERIAL_PATH}` });
      }
    });

    serialPort.on('close', () => {
      console.warn('[SERIAL] Port closed');
      io.emit('serial_status', { connected: false, message: 'Serial port closed' });
    });

    serialPort.on('error', (err) => {
      console.error('[SERIAL] Error:', err.message);
      io.emit('serial_status', { connected: false, message: err.message });
    });

    // Listen for data coming back FROM the STM32
    parser.on('data', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      console.log(`[STM32 →] ${trimmed}`);

      const timestamp = new Date().toISOString();
      io.emit('stm32_response', { timestamp, data: trimmed });

      // Append to log (STM32 response column only — name/pressure logged at send time)
      fs.appendFileSync(LOG_FILE, `${timestamp},,,${trimmed}\n`);
    });

  } catch (err) {
    console.error('[SERIAL] Init error:', err.message);
  }
}

initSerial();

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- REST: Send command to STM32 ---
app.post('/api/run', (req, res) => {
  const { name, pressure } = req.body;

  if (!name || pressure === undefined) {
    return res.status(400).json({ error: 'Missing name or pressure' });
  }

  const pressureNum = parseFloat(pressure);
  if (isNaN(pressureNum) || pressureNum < 0) {
    return res.status(400).json({ error: 'Pressure must be a non-negative number' });
  }

  // Format: NAME:John;PRESSURE:45.5\n
  const payload = `NAME:${name.trim()};PRESSURE:${pressureNum.toFixed(2)}\n`;

  if (!serialPort || !serialPort.isOpen) {
    return res.status(503).json({ error: 'Serial port is not open' });
  }

  serialPort.write(payload, (err) => {
    if (err) {
      console.error('[TX] Write error:', err.message);
      return res.status(500).json({ error: err.message });
    }

    const timestamp = new Date().toISOString();
    console.log(`[→ STM32] ${payload.trim()}`);

    // Log the outgoing command
    fs.appendFileSync(LOG_FILE, `${timestamp},${name.trim()},${pressureNum.toFixed(2)},\n`);

    res.json({ success: true, sent: payload.trim(), timestamp });
  });
});

// --- REST: Fetch log ---
app.get('/api/log', (req, res) => {
  fs.readFile(LOG_FILE, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Could not read log' });
    res.type('text/plain').send(data);
  });
});

// --- REST: Serial port status ---
app.get('/api/status', (req, res) => {
  res.json({
    connected: serialPort ? serialPort.isOpen : false,
    path: SERIAL_PATH,
    baudRate: BAUD_RATE,
  });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('[WS] Client connected');
  // Send current serial status on connect
  socket.emit('serial_status', {
    connected: serialPort ? serialPort.isOpen : false,
    message: serialPort?.isOpen ? `Connected on ${SERIAL_PATH}` : 'Not connected',
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀  Server running at http://localhost:${PORT}\n`);
});
