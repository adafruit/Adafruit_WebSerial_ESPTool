// let the editor know that `Chart` is defined by some code
// included in another file (in this case, `index.html`)
// Note: the code will still work without this line, but without it you
// will see an error in the editor
/* global TransformStream */
/* global TextEncoderStream */
/* global TextDecoderStream */

//'use strict';

let port;
let reader;
let inputDone;
let outputDone;
let inputStream;
let outputStream;

const baudRates = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000, 2000000];
const flashSizes = {
    "512KB": 0x00,
    "256KB": 0x10,
    "1MB": 0x20,
    "2MB": 0x30,
    "4MB": 0x40,
    "2MB-c1": 0x50,
    "4MB-c1": 0x60,
    "8MB": 0x80,
    "16MB": 0x90,
};

const FLASH_WRITE_SIZE = 0x200;
const FLASH_SECTOR_SIZE = 0x1000;  // Flash sector size, minimum unit of erase.
const ESP_ROM_BAUD = 115200;
const DEFAULT_TIMEOUT = 3000;

const SYNC_PACKET = toUTF8Array("\x07\x07\x12 UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU");
const SYNC_TIMEOUT = 100;          // timeout for syncing with bootloader in ms
const CHIP_DETECT_MAGIC_REG_ADDR = 0x40001000;
const ESP8266 = 0x8266;
const ESP32 = 0x32;
const ESP32_DATAREGVALUE = 0x15122500;
const ESP8266_DATAREGVALUE = 0x00062000;

// Commands supported by ESP8266 ROM bootloader
const ESP_FLASH_BEGIN = 0x02;
const ESP_FLASH_DATA = 0x03;
const ESP_FLASH_END = 0x04;
const ESP_MEM_BEGIN = 0x05;
const ESP_MEM_END = 0x06;
const ESP_MEM_DATA = 0x07;
const ESP_SYNC = 0x08;
const ESP_WRITE_REG = 0x09;
const ESP_READ_REG = 0x0A;

const ESP_SPI_SET_PARAMS = 0x0B;
const ESP_SPI_ATTACH = 0x0D;
const ESP_CHANGE_BAUDRATE = 0x0F;
const ESP_SPI_FLASH_MD5 = 0x13;
const ESP_CHECKSUM_MAGIC = 0xEF;

const bufferSize = 512;
const colors = ['#00a7e9', '#f89521', '#be1e2d'];
const measurementPeriodId = '0001';

const maxLogLength = 500;
const log = document.getElementById('log');
const butConnect = document.getElementById('butConnect');
const baudRate = document.getElementById('baudRate');
const butClear = document.getElementById('butClear');
const autoscroll = document.getElementById('autoscroll');
const lightSS = document.getElementById('light');
const darkSS = document.getElementById('dark');
const darkMode = document.getElementById('darkmode');
const butRemix = document.querySelector(".remix button");

let colorIndex = 0;
let activePanels = [];
let bytesReceived = 0;
let currentBoard;
let buttonState = 0;
let inputBuffer = [];

document.addEventListener('DOMContentLoaded', () => {
  butConnect.addEventListener('click', clickConnect);
  butClear.addEventListener('click', clickClear);
  autoscroll.addEventListener('click', clickAutoscroll);
  darkMode.addEventListener('click', clickDarkMode);
  butRemix.addEventListener('click', remix);

  if ('serial' in navigator) {
    const notSupported = document.getElementById('notSupported');
    notSupported.classList.add('hidden');
  }

  initBaudRate();
  loadAllSettings();
  updateTheme();
  logMsg("Adafruit WebSerial ESPTool loaded.");
});

function remix() {
  let projectUrl = window.location.href.replace('.glitch.me/', '').replace('://', '://glitch.com/edit/#!/remix/');
  window.location.href = projectUrl;
}

/**
 * @name connect
 * Opens a Web Serial connection to a micro:bit and sets up the input and
 * output stream.
 */
async function connect() {
  // - Request a port and open a connection.
  port = await navigator.serial.requestPort();
  
  /*
  Baud Rate should start at 115200
  on ESP8266, we can't change
  On ESP32, we can change after the inital 115200
  */
  
  logMsg("Connecting...")
  // - Wait for the port to open.toggleUIConnected
  await port.open({ baudRate: 115200 });

  // Turn off Serial Break signal.
  await port.setSignals({ break: false });

  // Turn on Data Terminal Ready (DTR) signal.
  await port.setSignals({ dataTerminalReady: true });

  // Turn off Request To Send (RTS) signal.
  await port.setSignals({ requestToSend: false });

  const signals = await port.getSignals();
  debugMsg(`Clear To Send:       ${signals.clearToSend}`);
  debugMsg(`Data Carrier Detect: ${signals.dataCarrierDetect}`);
  debugMsg(`Data Set Ready:      ${signals.dataSetReady}`);
  debugMsg(`Ring Indicator:      ${signals.ringIndicator}`);
  
  logMsg("connected successfully.")

  outputStream = port.writable;
  inputStream = port.readable;
  
  readLoop().catch((error) => {
    toggleUIConnected(false);
  });
}

function initBaudRate() {
  for (let rate of baudRates) {
    var option = document.createElement("option");
    option.text = rate + " Baud";
    option.value = rate;
    baudRate.add(option);
  }
}

/**
 * @name toUTF8Array
 * Convert a string to a UTF8 byte array
 */
function toUTF8Array(str) {
  let utf8 = [];
  for (let i = 0; i < str.length; i++) {
    let charcode = str.charCodeAt(i);
    if (charcode < 0x80) {
      utf8.push(charcode);
    } else if (charcode < 0x800) {
      utf8.push(0xc0 | (charcode >> 6),
                0x80 | (charcode & 0x3f));
    } else if (charcode < 0xd800 || charcode >= 0xe000) {
      utf8.push(0xe0 | (charcode >> 12),
                0x80 | ((charcode>>6) & 0x3f),
                0x80 | (charcode & 0x3f));
    } else {
      i++;
      charcode = 0x10000 + (((charcode & 0x3ff) << 10)
                | (str.charCodeAt(i) & 0x3ff));
      utf8.push(0xf0 | (charcode >>18),
                0x80 | ((charcode>>12) & 0x3f),
                0x80 | ((charcode>>6) & 0x3f),
                0x80 | (charcode & 0x3f));
    }
  }
  return utf8;
}

/**
 * @name disconnect
 * Closes the Web Serial connection.
 */
async function disconnect() {
  
  if (reader) {
    await reader.cancel();
    await inputDone.catch(() => {});
    reader = null;
    inputDone = null;
  }

  if (outputStream) {
    await outputStream.getWriter().close();
    await outputDone;
    outputStream = null;
    outputDone = null;
  }
  
  await port.close();
  port = null;
}

/**
 * @name readLoop
 * Reads data from the input stream and places it in the inputBuffer
 */
async function readLoop() {
  const reader = port.readable.getReader();
  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      debugMsg('DONE', done);
      reader.releaseLock();
      break;
    }
    debugMsg("Incoming Data:", value);
    console.log(value);
    inputBuffer = inputBuffer.concat(value);
  }
}

function logMsg(text) {
  log.innerHTML += text+ "<br>";

  // Remove old log content
  if (log.textContent.split("\n").length > maxLogLength + 1) {
    let logLines = log.innerHTML.replace(/(\n)/gm, "").split("<br>");
    log.innerHTML = logLines.splice(-maxLogLength).join("<br>\n");
  }

  if (autoscroll.checked) {
    log.scrollTop = log.scrollHeight
  }
}

function debugMsg(...args) {
  let isStrict = (function() { return !this; })();
  let prefix = "";
  if (!isStrict) {
    prefix = '<span class="debug-function">[' + debugMsg.caller.name + ']</span> ';
  }
  for (let arg of args) {
    if (typeof arg == "string") {
      logMsg(prefix + arg);
    } else if (typeof arg == "number") {
      logMsg(prefix + arg);
    } else if (typeof arg == "boolean") {
      logMsg(prefix + arg ? "true" : "false");
    } else if (Array.isArray(arg)) {
      logMsg(prefix + "[" + arg.map(value => toHex(value)).join(", ") + "]");
    } else if (typeof arg == "object" && (arg instanceof Uint8Array)) {
      logMsg(prefix + "[" + Array.from(arg).map(value => toHex(value)).join(", ") + "]");
    } else {
      logMsg(prefix + "Unhandled type of argument:" + typeof arg);
      console.log(arg)
    }
    prefix = "";  // Only show for first argument
  }
}

function toHex(value) {
  return "0x" + value.toString(16).padStart(2, "0");
}

/**
 * @name writeToStream
 * Gets a writer from the output stream and send the raw data over WebSerial.
 */
async function writeToStream(data) {
  const writer = outputStream.getWriter();
  await writer.write(new Uint8Array(data));
  writer.releaseLock();
}


/**
 * @name updateTheme
 * Sets the theme to  Adafruit (dark) mode. Can be refactored later for more themes
 */
function updateTheme() {
  // Disable all themes
  document
    .querySelectorAll('link[rel=stylesheet].alternate')
    .forEach((styleSheet) => {
      enableStyleSheet(styleSheet, false);
    });

  if (darkMode.checked) {
    enableStyleSheet(darkSS, true);
  } else {
    enableStyleSheet(lightSS, true);
  }
}

function enableStyleSheet(node, enabled) {
  node.disabled = !enabled;
}

/**
 * @name reset
 * Reset the Panels, Log, and associated data
 */
async function reset() {
  bytesReceived = 0;

  // Clear the log
  log.innerHTML = "";
}

/**
 * @name clickConnect
 * Click handler for the connect/disconnect button.
 */
async function clickConnect() {
  if (port) {
    await disconnect();
    toggleUIConnected(false);
    return;
  }

  await connect().then(_ => {
    toggleUIConnected(true);
    if (!espTool.sync()) {
      debugMsg("Unable to Sync");
    }
  }).catch(() => {});  
}

/**
 * @name changeBaudRate
 * Change handler for the Baud Rate selector.
 */
async function changeBaudRate() {
  saveSetting('baudrate', baudRate.value);
}

async function onDisconnected(event) {
  //let disconnectedDevice = event.target;

  toggleUIConnected(false);
}

/**
 * @name clickAutoscroll
 * Change handler for the Autoscroll checkbox.
 */
async function clickAutoscroll() {
  saveSetting('autoscroll', autoscroll.checked);
}

/**
 * @name clickDarkMode
 * Change handler for the Dark Mode checkbox.
 */
async function clickDarkMode() {
  updateTheme();
  saveSetting('darkmode', darkMode.checked);
}


/**
 * @name clickClear
 * Click handler for the clear button.
 */
async function clickClear() {
  reset();
}

function convertJSON(chunk) {
  try {
    let jsonObj = JSON.parse(chunk);
    return jsonObj;
  } catch (e) {
    return chunk;
  }
}

function toggleUIConnected(connected) {
  let lbl = 'Connect';
  if (connected) {
    lbl = 'Disconnect';
  }
  butConnect.textContent = lbl;
}

function loadAllSettings() {
  // Load all saved settings or defaults
  autoscroll.checked = loadSetting('autoscroll', true);
  baudRate.value = loadSetting('baudrate', 115200);
  darkMode.checked = loadSetting('darkmode', false);
}

function loadSetting(setting, defaultValue) {
  let value = JSON.parse(window.localStorage.getItem(setting));
  if (value == null) {
    return defaultValue;
  }

  return value;
}

function saveSetting(setting, value) {
  window.localStorage.setItem(setting, JSON.stringify(value));
}

function ucWords(text) {
  return text.replace('_', ' ').toLowerCase().replace(/(?<= )[^\s]|^./g, a=>a.toUpperCase())
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let espTool = {

  chipFamily: null,
  efuses: [0, 0, 0, 0],
  debug: true,

  /**
   * @name slipEncode
   * Take an array buffer and return back a new array where
   * 0xdb is replaced with 0xdb 0xdd and 0xc0 is replaced with 0xdb 0xdc
   */
  slipEncode: function(buffer) {
    let encoded = [];
    for (let byte of buffer) {
      if (byte == 0xDB) {
        encoded = encoded.concat([0xDB, 0xDD]);
      } else if (byte == 0xC0) {
        encoded = encoded.concat([0xDB, 0xDC]);
      } else {
        encoded.push(byte);
      }
    }
    return encoded;
  },

  /**
   * @name macAddr
   * The MAC address burned into the OTP memory of the ESP chip
   */
  macAddr: function() {
    let macAddr = new Array(6).fill(0);
    let mac0 = this.efuses[0];
    let mac1 = this.efuses[1];
    let mac2 = this.efuses[2];
    let mac3 = this.efuses[3];
    let oui;
    if (this.chipFamily == ESP8266) {
      if (mac3 != 0) {
        oui = [(mac3 >> 16) & 0xFF, (mac3 >> 8) & 0xFF, mac3 & 0xFF];
      } else if (((mac1 >> 16) & 0xFF) == 0) {
        oui = [0x18, 0xFE, 0x34];
      } else if (((mac1 >> 16) & 0xFF) == 1) {
        oui = [0xAC, 0xD0, 0x74];
      } else {
        debugMsg("Couldnt determine OUI");
        return;
      }

      macAddr[0] = oui[0];
      macAddr[1] = oui[1];
      macAddr[2] = oui[2];
      macAddr[3] = (mac1 >> 8) & 0xFF;
      macAddr[4] = mac1 & 0xFF;
      macAddr[5] = (mac0 >> 24) & 0xFF;
    } else if (this.chipFamily == ESP32) {
      macAddr[0] = mac2 >> 8 & 0xFF;
      macAddr[1] = mac2 & 0xFF;
      macAddr[2] = mac1 >> 24 & 0xFF;
      macAddr[3] = mac1 >> 16 & 0xFF;
      macAddr[4] = mac1 >> 8 & 0xFF;
      macAddr[5] = mac1 & 0xFF;
    } else {
      debugMsg("Unknown chip family")
    }
    return macAddr;
  },

  /**
   * @name readEfuses
   * Read the OTP data for this chip and store into this.efuses array
   */
  readEfuses: function() {
    let baseAddr
    if (this.chipFamily == ESP8266) {
      baseAddr = 0x3FF00050;
    } else if (this.chipFamily == ESP32) {
      baseAddr = 0x6001A000;
    } else {
      logMsg("Don't know what chip this is");
      return;
    }
    for (let i = 0; i < 4; i++) {
      this.efuses[i] = this.readRegister(baseAddr + 4 * i);
    }
  },

  /**
   * @name readRegister
   * Read a register within the ESP chip RAM, returns a 4-element list
   */
  readRegister: function(reg) {
    debugMsg("Reading Register");
    let packet = this.pack("I", reg);
    let register = this.checkCommand(ESP_READ_REG, packet)[0];
    return this.unpack("I", register)[0];
  },

  /**
   * @name chipType
   * ESP32 or ESP8266 based on which chip type we're talking to
   */
  chipType: function() {
    debugMsg("Checking Chip type");
    if (this.chipFamily === null) {
      let datareg = this.readRegister(0x60000078);
      if (datareg == ESP32_DATAREGVALUE) {
        this.chipFamily = ESP32
      } else if (datareg == ESP8266_DATAREGVALUE) {
        this.chipFamily = ESP8266
      } else {
        logMsg("Unknown Chip. Datareg is " + toHex(datareg));
      }
    }
    return this.chipFamily;
  },

  /**
   * @name checkCommand
   * Send a command packet, check that the command succeeded and
   * return a tuple with the value and data.
   * See the ESP Serial Protocol for more details on what value/data are
   */
  checkCommand: function(opcode, buffer, checksum=0, timeout=DEFAULT_TIMEOUT) {
    debugMsg("Running Check Command");
    this.sendCommand(opcode, buffer);
    debugMsg("Running Get Response");
    let [value, data] = this.getResponse(opcode, timeout);
    console.log(value);
    console.log(data);
    let status_len;
    if (this.chipFamily == ESP8266) {
        status_len = 2;
    } else if (this.chipFamily == ESP32) {
        status_len = 4;
    } else {
        if ([2, 4].includes(data.length)) {
            status_len = data.length;
        }
    }
    if (data === null || data.length < status_len) {
      debugMsg("Didn't get enough status bytes");
      return;
    }
    status = data.slice(-status_len);
    data = data.slice(0, -status_len);
    debugMsg("status", status);
    debugMsg("value", value);
    debugMsg("data", data);
    if (status[0] != 0) {
      logMsg("Command failure error code " + toHex(status[1]))
    }
    return [value, data];
  },

  /**
   * @name sendCommand
   * Send a slip-encoded, checksummed command over the UART,
   * does not check response
   */
  sendCommand: function(opcode, buffer) {
    debugMsg("Running Send Command");
    inputBuffer = []; // Reset input buffer
    let checksum = 0;
    if (opcode == 0x03) {
      checksum = this.checksum(buffer.slice(16));
    }

    let packet = [0xC0, 0x00];  // direction
    packet.push(opcode);
    packet = packet.concat(this.pack("H", buffer.length));
    packet = packet.concat(this.slipEncode(this.pack("I", checksum)));
    packet = packet.concat(this.slipEncode(buffer));
    packet.push(0xC0);
    if (this.debug) {
      debugMsg("Writing " + packet.length + " byte" + (packet.length == 1 ? "" : "s") + ":", packet);
    }
    writeToStream(packet)
  },

  /**
   * @name getResponse
   * Read response data and decodes the slip packet, then parses
   * out the value/data and returns as a tuple of (value, data) where
   * each is a list of bytes
   */
  getResponse: function (opcode, timeout=DEFAULT_TIMEOUT) {
    let reply = []

    let packet_length = 0;
    let escaped_byte = false;
    let timedOut = false;
    let stamp = Date.now()
     
    while (Date.now() - stamp < timeout) {
      if (inputBuffer.length > 0) {
        let c = inputBuffer.shift();
        if (c == 0xDB) {
          escaped_byte = true;
        } else if (escaped_byte) {
          if (c == 0xDD) {
            reply.push(0xDC);
          } else if (c == 0xDC) {
            reply.push(0xC0);
          } else {
            reply = reply.concat([0xDB, c]);
          }
          escaped_byte = false;
        } else {
          reply.push(c);
        }
      }
      if (reply.length > 0 && reply[0] != 0xC0) {
        // packets must start with 0xC0
        reply.shift();
      }
      if (reply.length > 1 && reply[1] != 0x01) {
        reply.shift();
      }
      if (reply.length > 2 && reply[2] != opcode) {
        reply.shift();
      }
      if (reply.length > 4) {
        // get the length
        packet_length = reply[3] + (reply[4] << 8);
      }
      if (reply.length == packet_length + 10) {
          break;
      }
    }

    // Check to see if we have a complete packet. If not, we timed out.
    if (reply.length != packet_length + 10) {
      if (this.debug) {
        debugMsg("Timed out after " + timeout + " milliseconds");
      }
      return [null, null];
    }
    if (this.debug) {
        debugMsg("Reading" + reply.length + " byte" + (reply.length == 1 ? "" : "s") + ":", reply);
    }
    let value = reply.slice(5, 9);
    let data = reply.slice(9, -1);
    if (this.debug) {
      debugMsg("value:", value, "data:", data);
    }
    return [value, data];
  },

  /**
   * @name checksum
   * Calculate checksum of a blob, as it is defined by the ROM
   */
  checksum: function(data, state=ESP_CHECKSUM_MAGIC) {
    for (let b of data) {
      state ^= b;
    }
    return state;
  },

  pack: function(...args) {
    let format = args[0];
    let data = args.slice(1);
    if (format.length != data.length) {
      debugMsg("Format to Argument count mismatch");
      return;
    }
    let bytes = [];
    for (let i = 0; i < data.length; i++) {
      if (format[i] == "B") {
        bytes.push((data[i] & 0xFF));
      } else if (format[i] == "H") {
        bytes.push((data[i] & 0xFF));
        bytes.push((data[i] >> 8) & 0xFF);
      } else if (format[i] == "I") {
        bytes.push((data[i] & 0xFF));
        bytes.push((data[i] >> 8) & 0xFF);
        bytes.push((data[i] >> 16) & 0xFF);
        bytes.push((data[i] >> 24) & 0xFF);
      } else {
        debugMsg("Unhandled character in format");
      }  
    }
    
    return bytes;
  },

  unpack: function(format, bytes) {
    let pointer = 0;
    let data = [];
    for (let c of format) {
      if (c == "B") {
        data.push((bytes[pointer] & 0xFF));
        pointer += 1;
      } else if (c == "H") {
        data.push(
          (bytes[pointer] & 0xFF) | 
          ((bytes[pointer + 1] & 0xFF) << 8)
        );
        pointer += 2;
      } else if (c == "I") {
        data.push(
          (bytes[pointer] & 0xFF) | 
          ((bytes[pointer + 1] & 0xFF) << 8) |
          ((bytes[pointer + 2] & 0xFF) << 16) |
          ((bytes[pointer + 3] & 0xFF) << 24))
        pointer += 4;
      } else {
        debugMsg("Unhandled character in format");
      }
    }
    return data;
  },

  /**
   * @name sync
   * Put into ROM bootload mode & attempt to synchronize with the
   * ESP ROM bootloader, we will retry a few times
   */
  sync: async function() {
    //this.reset(true)

    for (let i = 0; i < 5; i++) {
      if (this._sync()) {
        await sleep(100);
        return true;
      }
      await sleep(100);
    }

    logMsg("Couldn't sync to ESP");
  },

  /**
   * @name _sync
   * Perform a soft-sync using AT sync packets, does not perform
   * any hardware resetting
   */
  _sync: function() {
    debugMsg("Sending sync packet");
    this.sendCommand(ESP_SYNC, SYNC_PACKET);
    for (let i = 0; i < 8; i++) {
      let [reply, data] = this.getResponse(ESP_SYNC, SYNC_TIMEOUT)
      if (!data) {
        continue;
      }
      if (!data.length > 1 && data[0] == 0 && data[1] == 0) {
        return true;
      }
    }
    return false;
  }
}
