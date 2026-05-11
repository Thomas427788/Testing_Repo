// All of these are Node.js libraries. This is 
// basically describing that Node.js is loading
// in these optional libraries, and we are 
// naming them all constant values with which
// we call in their modules, ie express.bleh
const express = require('express');
const http = require('http');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

// express() is a javascript library used for web making
// we are going to rename it 'app' to call it faster
// and make it more readable
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const SERIAL_PATH = '/dev/ttyACM0';  // STM32 USB CDC Virtual COM Port
const BAUD_RATE = 115200;
const LOG_FILE = path.join(__dirname, 'session_log.csv');

// --- Ensure log file has a header ---
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'timestamp,name,pressure_psi,application_time,stm32_response\n');
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

      // Append to log (STM32 response column only — name/pressure/application_time logged at send time)

	const pressureMatch = trimmed.match(/PRESSURE:([\d.]+)/i);
	if (pressureMatch) {
	  const pressure = parseFloat(pressureMatch[1]);
	  if (!isNaN(pressure)) {
	    io.emit('pressure_reading', { timestamp, pressure });
	    console.log(`[PI] Pressure reading: ${pressure} PSI`);
	  }
	}


	//const timeMatch = trimmed.match(/DURATION:([\d.]+)/i);
	//if (timeMatch) {
	//  const applicationTime = parseFloat(applicationTimeMatch[1]);
	//  if (!isNaN(applicationTime)) {
	//    io.emit('applicationTime_reading', { applicationTimestamp, pressure });
	//    console.log(`[PI] Time reading: ${applicationTime} seconds`);
	//  }
	//}

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
	// This is the request body that is being created
  const { name, pressure, applicationTime } = req.body; // { wow, 5.0 } time is not working
  //console.log("This is the request body from the HTML page");
  //console.log(req.body);

  //console.log("RT thing")
  //console.log(req.body["applicationTime"]);

  //console.log("define 'time' as req.body'applicationTime'")
  const time = req.body["applicationTime"];


  //console.log("This is the 'pressure' variable");
  //console.log(pressure);

  //console.log("This is the 'time' variable");
  //console.log(applicationTime);

  if (!name || pressure === undefined) {
    return res.status(400).json({ error: 'Missing name or pressure' });
  }

  const pressureNum = parseFloat(pressure);
  if (isNaN(pressureNum) || pressureNum < 0) {
    return res.status(400).json({ error: 'Pressure must be a non-negative number' });
  }

  const timeNum = parseFloat(applicationTime);
  //console.log("This is the 'timeNum' variable that comes from parseFloat(time)");
  //console.log(timeNum);
  if ( isNaN(timeNum) ) {
    return res.status(400).json({ error: 'Time is NaN' });
  }
  // Format: NAME:John;PRESSURE:45.5;TIME:10\n
  const payload = `NAME:${name.trim()};PRESSURE:${pressureNum.toFixed(2)};TIME:${timeNum.toFixed(2)}\n`;

  if (!serialPort || !serialPort.isOpen) {
    return res.status(503).json({ error: 'Serial port is not open' });
  }

  serialPort.write(payload, (err) => {
    if (err) {
      console.error('[TX] Write error:', err.message);
      return res.status(500).json({ error: err.message });
    }

    const timestamp = new Date().toISOString();
    console.log(`${payload.trim()}`);

    // Log the outgoing command to the csv file in the home directory
    fs.appendFileSync(LOG_FILE, `${timestamp},${name.trim()},${pressureNum.toFixed(2)},${timeNum.toFixed(2)}\n`);
    res.json({ success: true, sent: payload.trim(), timestamp });
  });
});

// --- REST: Send calibrate command to STM32 ---
app.post('/api/calibrate', (req, res) => {
  if (!serialPort || !serialPort.isOpen) {
    return res.status(503).json({ error: 'Serial port is not open' });
  }

  const payload = `CMD:CALIBRATE\n`;

  serialPort.write(payload, (err) => {
    if (err) {
      console.error('[TX] Calibrate write error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    const timestamp = new Date().toISOString();
    console.log(`[CALIBRATE] Command sent`);
    fs.appendFileSync(LOG_FILE, `${timestamp},CALIBRATE,,,\n`);
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
