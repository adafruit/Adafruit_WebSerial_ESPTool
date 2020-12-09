'use strict';

let port;
let reader;
let inputStream;
let outputStream;
let espTool;
let isConnected = false;
let stubLoader = null;

const baudRates = [921600, 115200, 230400, 460800];
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
const ESP32S2_FLASH_WRITE_SIZE = 0x400;
const FLASH_SECTOR_SIZE = 0x1000;  // Flash sector size, minimum unit of erase.
const ESP_ROM_BAUD = 115200;

const SYNC_PACKET = toByteArray("\x07\x07\x12 UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU");
const CHIP_DETECT_MAGIC_REG_ADDR = 0x40001000;
const ESP8266 = 0x8266;
const ESP32 = 0x32;
const ESP32S2 = 0x3252;
const ESP32_DATAREGVALUE = 0x15122500;
const ESP8266_DATAREGVALUE = 0x00062000;
const ESP32S2_DATAREGVALUE = 0x500;

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

const ESP_ERASE_FLASH = 0xD0;
const ESP_ERASE_REGION = 0xD1;

const ESP_SPI_SET_PARAMS = 0x0B;
const ESP_SPI_ATTACH = 0x0D;
const ESP_CHANGE_BAUDRATE = 0x0F;
const ESP_SPI_FLASH_MD5 = 0x13;
const ESP_CHECKSUM_MAGIC = 0xEF;

const ROM_INVALID_RECV_MSG = 0x05;

const USB_RAM_BLOCK = 0x800;
const ESP_RAM_BLOCK = 0x1800;

// Timeouts
const DEFAULT_TIMEOUT = 3000;
const CHIP_ERASE_TIMEOUT = 600000;             // timeout for full chip erase in ms
const MAX_TIMEOUT = CHIP_ERASE_TIMEOUT * 2;    // longest any command can run in ms
const SYNC_TIMEOUT = 100;                      // timeout for syncing with bootloader in ms
const ERASE_REGION_TIMEOUT_PER_MB = 30000;     // timeout (per megabyte) for erasing a region in ms
const MEM_END_ROM_TIMEOUT = 50;

const bufferSize = 512;
const colors = ['#00a7e9', '#f89521', '#be1e2d'];
const measurementPeriodId = '0001';

const maxLogLength = 500;
const log = document.getElementById('log');
const butConnect = document.getElementById('butConnect');
const baudRate = document.getElementById('baudRate');
const butClear = document.getElementById('butClear');
const offset = document.getElementById('offset');
const butErase = document.getElementById('butErase');
const autoscroll = document.getElementById('autoscroll');
const lightSS = document.getElementById('light');
const darkSS = document.getElementById('dark');
const darkMode = document.getElementById('darkmode');
const firmware = document.getElementById('firmware');
const appDiv = document.getElementById('app');
const butRemix = document.querySelector(".remix button");

let colorIndex = 0;
let activePanels = [];
let bytesReceived = 0;
let currentBoard;
let buttonState = 0;
let inputBuffer = [];

document.addEventListener('DOMContentLoaded', () => {
  espTool = new EspLoader()
  butConnect.addEventListener('click', () => {
    clickConnect();/*.catch(async (e) => {
      errorMsg(e.message);
      disconnect();
      toggleUIConnected(false);
    });*/
  });
  butClear.addEventListener('click', clickClear);
  butErase.addEventListener('click', clickErase);
  autoscroll.addEventListener('click', clickAutoscroll);
  baudRate.addEventListener('change', changeBaudRate);
  darkMode.addEventListener('click', clickDarkMode);
  butRemix.addEventListener('click', remix);
  firmware.addEventListener('change', uploadFirmware);
  window.addEventListener('error', function(event) {
    console.log("Got an uncaught error: ", event.error)
  });
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

  logMsg("Connecting...")
  // - Wait for the port to open.toggleUIConnected
  await port.open({ baudRate: ESP_ROM_BAUD });

  const signals = await port.getSignals();

  logMsg("Connected successfully.")

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
 * @name toByteArray
 * Convert a string to a byte array
 */
function toByteArray(str) {
  let byteArray = [];
  for (let i = 0; i < str.length; i++) {
    let charcode = str.charCodeAt(i);
    if (charcode <= 0xFF) {
      byteArray.push(charcode);
    } else if (charcode < 0x800) {
      byteArray.push(0xc0 | (charcode >> 6),
                     0x80 | (charcode & 0x3f));
    } else if (charcode < 0xd800 || charcode >= 0xe000) {
      byteArray.push(0xe0 | (charcode >> 12),
                     0x80 | ((charcode>>6) & 0x3f),
                     0x80 | (charcode & 0x3f));
    } else {
      i++;
      charcode = 0x10000 + (((charcode & 0x3ff) << 10)
                | (str.charCodeAt(i) & 0x3ff));
      byteArray.push(0xf0 | (charcode >>18),
                     0x80 | ((charcode>>12) & 0x3f),
                     0x80 | ((charcode>>6) & 0x3f),
                     0x80 | (charcode & 0x3f));
    }
  }
  return byteArray;
}

/**
 * @name disconnect
 * Closes the Web Serial connection.
 */
async function disconnect() {
  toggleUIToolbar(false);
  if (reader) {
    await reader.cancel();
    reader = null;
  }

  if (outputStream) {
    await outputStream.getWriter().close();
    outputStream = null;
  }

  await port.close();
  port = null;
}

/**
 * @name readLoop
 * Reads data from the input stream and places it in the inputBuffer
 */
async function readLoop() {
  reader = port.readable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      reader.releaseLock();
      break;
    }
    inputBuffer = inputBuffer.concat(Array.from(value));
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
  function getStackTrace() {
    let stack = new Error().stack;
    //console.log(stack);
    stack = stack.split("\n").map(v => v.trim());
    stack.shift();
    stack.shift();

    let trace = [];
    for (let line of stack) {
      line = line.replace("at ", "");
      trace.push({
        "func": line.substr(0, line.indexOf("(") - 1),
        "pos": line.substring(line.indexOf(".js:") + 4, line.lastIndexOf(":"))
      });
    }

    return trace;
  }

  let stack = getStackTrace();
  stack.shift();
  let top = stack.shift();
  let prefix = '<span class="debug-function">[' + top.func + ":" + top.pos + ']</span> ';
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
      console.log(arg);
    }
    prefix = "";  // Only show for first argument
  }
}

function errorMsg(text) {
  logMsg('<span class="error-message">Error:</span> ' + text);
  console.log(text);
}

function formatMacAddr(macAddr) {
  return macAddr.map(value => value.toString(16).toUpperCase().padStart(2, "0")).join(":");
}

function toHex(value, size=2) {
  return "0x" + value.toString(16).toUpperCase().padStart(size, "0");
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

  await connect();

  toggleUIConnected(true);
  //try {
    if (await espTool.sync()) {
      toggleUIToolbar(true);
      appDiv.classList.add("connected");
      let baud = parseInt(baudRate.value);
      if (baudRates.includes(baud) && baud != ESP_ROM_BAUD) {
        await espTool.setBaudrate(baud);
      }
      logMsg("Connected to " + await espTool.chipName());
      logMsg("MAC Address: " + formatMacAddr(espTool.macAddr()));
      stubLoader = await espTool.runStub();
    }
  /*} catch(e) {
    errorMsg(e);
    await disconnect();
    toggleUIConnected(false);
    return;
  }*/
}

/**
 * @name changeBaudRate
 * Change handler for the Baud Rate selector.
 */
async function changeBaudRate() {
  saveSetting('baudrate', baudRate.value);
  if (isConnected) {
    let baud = parseInt(baudRate.value);
    if (baudRates.includes(baud)) {
      await espTool.setBaudrate(baud);
    }
  }
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
 * @name clickErase
 * Click handler for the erase button.
 */
async function clickErase() {
  baudRate.disabled = true;
  try {
    await stubLoader.eraseFlash();
  } catch(e) {
    errorMsg(e);
  } finally {
    baudRate.disabled = false;
  }
}

/**
 * @name clickClear
 * Click handler for the clear button.
 */
async function clickClear() {
  reset();
}

async function uploadFirmware() {
  let binfile = firmware.files[0];
  const reader = new FileReader();
  reader.addEventListener('load', async (event) => {
    baudRate.disabled = true;
    firmware.disabled = true;
    let label	= firmware.nextElementSibling;
    let labelVal = label.innerHTML;
    //try {
      label.querySelector('span').innerHTML = "Programming...";
      await espTool.flashData(event.target.result, parseInt(offset.value, 16));
    /*} catch(e) {
      errorMsg(e);
    } finally {
      label.innerHTML = labelVal;
      baudRate.disabled = false;
      firmware.disabled = false;
    }*/
  });
  reader.readAsArrayBuffer(binfile);
}

function convertJSON(chunk) {
  try {
    let jsonObj = JSON.parse(chunk);
    return jsonObj;
  } catch (e) {
    return chunk;
  }
}

function toggleUIToolbar(show) {
  isConnected = show;
  if (show) {
    appDiv.classList.add("connected");
  } else {
    appDiv.classList.remove("connected");
  }
  firmware.disabled = !show;
  offset.disabled = !show;
  butErase.disabled = !show;
}

function toggleUIConnected(connected) {
  let lbl = 'Connect';
  if (connected) {
    lbl = 'Disconnect';
  } else {
    toggleUIToolbar(false);
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

class EspLoader {
  constructor() {
    this._chipfamily = null;
    this._efuses = new Array(4).fill(0);
    this._flashsize = 4 * 1024 * 1024;
    this.debug = true;
    this.IS_STUB = false;
  }

  /**
   * @name slipEncode
   * Take an array buffer and return back a new array where
   * 0xdb is replaced with 0xdb 0xdd and 0xc0 is replaced with 0xdb 0xdc
   */
  slipEncode(buffer) {
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
  };

  /**
   * @name macAddr
   * The MAC address burned into the OTP memory of the ESP chip
   */
  macAddr() {
    let macAddr = new Array(6).fill(0);
    let mac0 = this._efuses[0];
    let mac1 = this._efuses[1];
    let mac2 = this._efuses[2];
    let mac3 = this._efuses[3];
    let oui;
    if (this._chipfamily == ESP8266) {
      if (mac3 != 0) {
        oui = [(mac3 >> 16) & 0xFF, (mac3 >> 8) & 0xFF, mac3 & 0xFF];
      } else if (((mac1 >> 16) & 0xFF) == 0) {
        oui = [0x18, 0xFE, 0x34];
      } else if (((mac1 >> 16) & 0xFF) == 1) {
        oui = [0xAC, 0xD0, 0x74];
      } else {
        throw("Couldnt determine OUI");
      }

      macAddr[0] = oui[0];
      macAddr[1] = oui[1];
      macAddr[2] = oui[2];
      macAddr[3] = (mac1 >> 8) & 0xFF;
      macAddr[4] = mac1 & 0xFF;
      macAddr[5] = (mac0 >> 24) & 0xFF;
    } else if (this._chipfamily == ESP32) {
      macAddr[0] = mac2 >> 8 & 0xFF;
      macAddr[1] = mac2 & 0xFF;
      macAddr[2] = mac1 >> 24 & 0xFF;
      macAddr[3] = mac1 >> 16 & 0xFF;
      macAddr[4] = mac1 >> 8 & 0xFF;
      macAddr[5] = mac1 & 0xFF;
    } else if (this._chipfamily == ESP32S2) {
      macAddr[0] = mac2 >> 8 & 0xFF;
      macAddr[1] = mac2 & 0xFF;
      macAddr[2] = mac1 >> 24 & 0xFF;
      macAddr[3] = mac1 >> 16 & 0xFF;
      macAddr[4] = mac1 >> 8 & 0xFF;
      macAddr[5] = mac1 & 0xFF;
    } else {
      throw("Unknown chip family")
    }
    return macAddr;
  };

  /**
   * @name _readEfuses
   * Read the OTP data for this chip and store into this.efuses array
   */
  async _readEfuses() {
    let baseAddr
    if (this._chipfamily == ESP8266) {
      baseAddr = 0x3FF00050;
    } else if (this._chipfamily == ESP32) {
      baseAddr = 0x6001A000;
    } else if (this._chipfamily == ESP32S2) {
      baseAddr = 0x6001A000;
    } else {
      throw("Don't know what chip this is");
    }
    for (let i = 0; i < 4; i++) {
      this._efuses[i] = await this.readRegister(baseAddr + 4 * i);
    }
  };

  /**
   * @name readRegister
   * Read a register within the ESP chip RAM, returns a 4-element list
   */
  async readRegister(reg) {
    if (this.debug) {
      debugMsg("Reading Register", reg);
    }
    let packet = this.pack("I", reg);
    let register = (await this.checkCommand(ESP_READ_REG, packet))[0];
    return this.unpack("I", register)[0];
  };

  /**
   * @name chipType
   * ESP32 or ESP8266 based on which chip type we're talking to
   */
  async chipType() {
    if (this._chipfamily === null) {
      let datareg = await this.readRegister(0x60000078);
      if (datareg == ESP32_DATAREGVALUE) {
        this._chipfamily = ESP32;
      } else if (datareg == ESP8266_DATAREGVALUE) {
        this._chipfamily = ESP8266;
      } else if (datareg == ESP32S2_DATAREGVALUE) {
        this._chipfamily = ESP32S2;
      } else {
        throw("Unknown Chip.");
      }
    }
    return this._chipfamily;
  };

  /**
   * @name chipType
   * The specific name of the chip, e.g. ESP8266EX, to the best
   * of our ability to determine without a stub bootloader.
   */
  async chipName() {
    await this.chipType();
    await this._readEfuses();

    if (await this.chipType() == ESP32) {
      return "ESP32";
    }
    if (await this.chipType() == ESP32S2) {
      return "ESP32-S2";
    }
    if (await this.chipType() == ESP8266) {
      if (this._efuses[0] & (1 << 4) || this._efuses[2] & (1 << 16)) {
        return "ESP8285";
      }
      return "ESP8266EX";
    }
    return null;
  };

  /**
   * @name checkCommand
   * Send a command packet, check that the command succeeded and
   * return a tuple with the value and data.
   * See the ESP Serial Protocol for more details on what value/data are
   */
  async checkCommand(opcode, buffer, checksum=0, timeout=DEFAULT_TIMEOUT) {
    timeout = Math.min(timeout, MAX_TIMEOUT);
    debugMsg("Pre-encoded data", buffer);
    await this.sendCommand(opcode, buffer, checksum);
    let [value, data] = await this.getResponse(opcode, timeout);
    let statusLen;
    if (data !== null) {
      if (this.IS_STUB) {
          statusLen = 2;
      } else if (this._chipfamily == ESP8266) {
          statusLen = 2;
      } else if ([ESP32, ESP32S2].includes(this._chipfamily)) {
          statusLen = 4;
      } else {
          if ([2, 4].includes(data.length)) {
              statusLen = data.length;
          }
      }
    }
    if (data === null || data.length < statusLen) {
      throw("Didn't get enough status bytes");
    }
    let status = data.slice(-statusLen, data.length);
    data = data.slice(0, -statusLen);
    if (this.debug) {
      debugMsg("status", status);
      debugMsg("value", value);
      debugMsg("data", data);
    }
    if (status[0] == 1) {
      if (status[1] == ROM_INVALID_RECV_MSG) {
        throw("Invalid (unsupported) command " + toHex(opcode));
      } else {
        throw("Command failure error code " + toHex(status[1]));
      }
    }
    return [value, data];
  };

  /**
   * @name timeoutPerMb
   * Scales timeouts which are size-specific
   */
  timeoutPerMb(secondsPerMb, sizeBytes) {
      let result = Math.floor(secondsPerMb * (sizeBytes / 0x1e6));
      if (result < DEFAULT_TIMEOUT) {
        return DEFAULT_TIMEOUT;
      }
      return result;
  };

  /**
   * @name sendCommand
   * Send a slip-encoded, checksummed command over the UART,
   * does not check response
   */
  async sendCommand(opcode, buffer, checksum=0) {
    //debugMsg("Running Send Command");
    inputBuffer = []; // Reset input buffer
    let packet = [0xC0, 0x00];  // direction
    packet.push(opcode);
    packet = packet.concat(this.pack("H", buffer.length));
    packet = packet.concat(this.slipEncode(this.pack("I", checksum)));
    packet = packet.concat(this.slipEncode(buffer));
    packet.push(0xC0);
    if (this.debug) {
      debugMsg("Writing " + packet.length + " byte" + (packet.length == 1 ? "" : "s") + ":", packet);
    }
    await writeToStream(packet);
  };

  /**
   * @name getResponse
   * Read response data and decodes the slip packet, then parses
   * out the value/data and returns as a tuple of (value, data) where
   * each is a list of bytes
   */
  async getResponse(opcode, timeout=DEFAULT_TIMEOUT) {
    let reply = [];
    let packetLength = 0;
    let escapedByte = false;
    let stamp = Date.now();
    while (Date.now() - stamp < timeout) {
      if (inputBuffer.length > 0) {
        let c = inputBuffer.shift();
        if (c == 0xDB) {
          escapedByte = true;
        } else if (escapedByte) {
          if (c == 0xDD) {
            reply.push(0xDC);
          } else if (c == 0xDC) {
            reply.push(0xC0);
          } else {
            reply = reply.concat([0xDB, c]);
          }
          escapedByte = false;
        } else {
          reply.push(c);
        }
      } else {
        await sleep(10);
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
        packetLength = reply[3] + (reply[4] << 8);
      }
      if (reply.length == packetLength + 10) {
        break;
      }
    }

    // Check to see if we have a complete packet. If not, we timed out.
    if (reply.length != packetLength + 10) {
      logMsg("Timed out after " + timeout + " milliseconds");
      return [null, null];
    }
    if (this.debug) {
      debugMsg("Reading " + reply.length + " byte" + (reply.length == 1 ? "" : "s") + ":", reply);
    }
    let value = reply.slice(5, 9);
    let data = reply.slice(9, -1);
    if (this.debug) {
      debugMsg("value:", value, "data:", data);
    }
    return [value, data];
  };

/**
   * @name read
   * Read response data and decodes the slip packet.
   * Keeps reading until we hit the timeout or get
   * a packet closing byte
   */
  async readBuffer(timeout=DEFAULT_TIMEOUT) {
    let reply = [];
    let packetLength = 0;
    let escapedByte = false;
    let stamp = Date.now();
    while (Date.now() - stamp < timeout) {
      if (inputBuffer.length > 0) {
        let c = inputBuffer.shift();
        if (c == 0xDB) {
          escapedByte = true;
        } else if (escapedByte) {
          if (c == 0xDD) {
            reply.push(0xDC);
          } else if (c == 0xDC) {
            reply.push(0xC0);
          } else {
            reply = reply.concat([0xDB, c]);
          }
          escapedByte = false;
        } else {
          reply.push(c);
        }
      } else {
        await sleep(10);
      }
      if (reply.length > 0 && reply[0] != 0xC0) {
        // packets must start with 0xC0
        reply.shift();
      }
      if (reply.length > 1 && reply[reply.length - 1] == 0xC0) {
        break;
      }
    }

    // Check to see if we have a complete packet. If not, we timed out.
    if (reply.length < 2) {
      logMsg("Timed out after " + timeout + " milliseconds");
      return null;
    }
    if (this.debug) {
      debugMsg("Reading " + reply.length + " byte" + (reply.length == 1 ? "" : "s") + ":", reply);
    }
    let data = reply.slice(1, -1);
    if (this.debug) {
      debugMsg("data:", data);
    }
    return data;
  };


  /**
   * @name checksum
   * Calculate checksum of a blob, as it is defined by the ROM
   */
  checksum(data, state=ESP_CHECKSUM_MAGIC) {
    for (let b of data) {
      state ^= b;
    }
    return state;
  };

  async setBaudrate(baud) {
    if (this._chipfamily == ESP8266) {
      logMsg("Baud rate can only change on ESP32 and ESP32-S2");
    }
    let buffer = this.pack("<II", baud, 0);
    await this.checkCommand(ESP_CHANGE_BAUDRATE, buffer);
    port.baudRate = baud;
    await sleep(50);
    await this.checkCommand(ESP_CHANGE_BAUDRATE, buffer);
    logMsg("Changed baud rate to " + port.baudRate);
  };

  pack(...args) {
    let format = args[0];
    let pointer = 0;
    let data = args.slice(1);
    if (format.replace(/[<>]/, '').length != data.length) {
      errorMsg("Pack format to Argument count mismatch");
      return;
    }
    let bytes = [];
    let littleEndian = true;
    for (let i = 0; i < format.length; i++) {
      if (format[i] == "<") {
        littleEndian = true;
      } else if (format[i] == ">") {
        littleEndian = false;
      } else if (format[i] == "B") {
        pushBytes(data[pointer], 1);
        pointer++;
      } else if (format[i] == "H") {
        pushBytes(data[pointer], 2);
        pointer++;
      } else if (format[i] == "I") {
        pushBytes(data[pointer], 4);
        pointer++;
      } else {
        errorMsg("Unhandled character in pack format");
      }
    }

    function pushBytes(value, byteCount) {
      for (let i = 0; i < byteCount; i++) {
        if (littleEndian) {
          bytes.push((value >> (i * 8)) & 0xFF);
        } else {
          bytes.push((value >> ((byteCount - i) * 8)) & 0xFF);
        }
      }
    }

    return bytes;
  };

  unpack(format, bytes) {
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
        errorMsg("Unhandled character in unpack format");
      }
    }
    return data;
  };

  /**
   * @name sync
   * Put into ROM bootload mode & attempt to synchronize with the
   * ESP ROM bootloader, we will retry a few times
   */
  async sync() {
    for (let i = 0; i < 5; i++) {
      let response = await this._sync();
      if (response) {
        await sleep(100);
        return true;
      }
      await sleep(100);
    }

    throw("Couldn't sync to ESP. Try resetting.");
  };

  /**
   * @name _sync
   * Perform a soft-sync using AT sync packets, does not perform
   * any hardware resetting
   */
  async _sync() {
    await this.sendCommand(ESP_SYNC, SYNC_PACKET);
    for (let i = 0; i < 8; i++) {
      let [reply, data] = await this.getResponse(ESP_SYNC, SYNC_TIMEOUT);
      if (data === null) {
        continue;
      }
      if (data.length > 1 && data[0] == 0 && data[1] == 0) {
        return true;
      }
    }
    return false;
  };

  /**
   * @name getFlashWriteSize
   * Get the Flash write size based on the chip
   */
  getFlashWriteSize() {
    if (this._chipfamily == ESP32S2) {
      return ESP32S2_FLASH_WRITE_SIZE;
    }
    return FLASH_WRITE_SIZE;
  };

  /**
   * @name flashData
   * Program a full, uncompressed binary file into SPI Flash at
   *   a given offset. If an ESP32 and md5 string is passed in, will also
   *   verify memory. ESP8266 does not have checksum memory verification in
   *   ROM
   */
  async flashData(binaryData, offset=0) {

    let filesize = binaryData.byteLength;
    logMsg("\nWriting data with filesize:" + filesize);
    let blocks = await this.flashBegin(filesize, offset);
    let block = [];
    let seq = 0;
    let written = 0;
    let address = offset;
    let position = offset;
    let stamp = Date.now();
    let flashWriteSize = this.getFlashWriteSize();

    while (filesize - position > 0) {
      logMsg(
          "Writing at " + toHex(address + seq * flashWriteSize, 8) + "... (" + Math.floor(100 * (seq + 1) / blocks)+ " %)"
      );
      if (filesize - position >= flashWriteSize) {
        block = Array.from(new Uint8Array(binaryData, position, flashWriteSize));
      } else {
        // Pad the last block
        block = Array.from(new Uint8Array(binaryData, position, filesize - position));
        block = block.concat(new Array(flashWriteSize - block.length).fill(0xFF));
      }
      await this.flashBlock(block, seq, 2000);
      seq += 1;
      written += block.length;
      position += flashWriteSize;
    }
    logMsg("Took " + (Date.now() - stamp) + "ms to write " + filesize + " bytes");
    logMsg("To run the new firmware, please reset your device.")
  };

  /**
   * @name flashBlock
   * Send one block of data to program into SPI Flash memory
   */
  async flashBlock(data, seq, timeout=100) {
    await this.checkCommand(
      ESP_FLASH_DATA,
      this.pack("<IIII", data.length, seq, 0, 0).concat(data),
      this.checksum(data),
      timeout,
    );
  };

  /**
   * @name flashBegin
   * Prepare for flashing by attaching SPI chip and erasing the
   *   number of blocks requred.
   */
  async flashBegin(size=0, offset=0, encrypted=false) {
    let eraseSize;
    let buffer;
    let flashWriteSize = this.getFlashWriteSize();
    if ([ESP32, ESP32S2].includes(this._chipfamily)) {
      await this.checkCommand(ESP_SPI_ATTACH, new Array(8).fill(0));
    }
    if (this._chipfamily == ESP32) {
      // We are hardcoded for 4MB flash on ESP32
      buffer = this.pack(
          "<IIIIII", 0, this._flashsize, 0x10000, 4096, 256, 0xFFFF
      )
      await this.checkCommand(ESP_SPI_SET_PARAMS, buffer);
    }
    let numBlocks = Math.floor((size + flashWriteSize - 1) / flashWriteSize);
    if (this._chipfamily == ESP8266) {
      eraseSize = this.getEraseSize(offset, size);
    } else {
      eraseSize = size;
    }

    let timeout;
    if (this.IS_STUB) {
      timeout = DEFAULT_TIMEOUT;
    } else {
      timeout = this.timeoutPerMb(ERASE_REGION_TIMEOUT_PER_MB, size);
    }

    let stamp = Date.now();
    buffer = this.pack(
        "<IIII", eraseSize, numBlocks, flashWriteSize, offset
    );
    if (this._chipfamily == ESP32S2) {
      buffer = buffer.concat(this.pack(
        "<I", encrypted ? 1 : 0
      ));
    }
    logMsg(
        "Erase size " + eraseSize + ", blocks " + numBlocks + ", block size " + flashWriteSize + ", offset " + toHex(offset, 4) + ", encrypted " + (encrypted ? "yes" : "no")
    );
    await this.checkCommand(ESP_FLASH_BEGIN, buffer, 0, timeout);
    if (size != 0 && !this.IS_STUB) {
      logMsg("Took " + (Date.now() - stamp) + "ms to erase " + numBlocks + " bytes");
    }
    return numBlocks;
  };

  async flashFinish() {
    let buffer = this.pack('<I', 1);
    await this.checkCommand(ESP_FLASH_END, buffer);
  };

  /**
   * @name getEraseSize
   * Calculate an erase size given a specific size in bytes.
   *   Provides a workaround for the bootloader erase bug on ESP8266.
   */
  getEraseSize(offset, size) {
    let sectorsPerBlock = 16;
    let sectorSize = FLASH_SECTOR_SIZE;
    let numSectors = Math.floor((size + sectorSize - 1) / sectorSize);
    let startSector = Math.floor(offset / sectorSize);

    let headSectors = sectorsPerBlock - (startSector % sectorsPerBlock);
    if (numSectors < headSectors) {
      headSectors = numSectors;
    }

    if (numSectors < 2 * headSectors) {
      return Math.floor((numSectors + 1) / 2 * sectorSize);
    }

    return (numSectors - headSectors) * sectorSize;
  };

    /**
   * @name memBegin (592)
   * Start downloading an application image to RAM
   */
  async memBegin(size, blocks, blocksize, offset) {
    if (this.IS_STUB) {
      let stub = await this.getStubCode();
      let load_start = offset;
      let load_end = offset + size;
      console.log(load_start, load_end);
      console.log(stub.data_start, stub.data.length, stub.text_start, stub.text.length);
      for (let [start, end] of [
        [stub.data_start, stub.data_start + stub.data.length],
        [stub.text_start, stub.text_start + stub.text.length]]
      ) {
        if (load_start < end && load_end > start) {
          throw("Software loader is resident at " + toHex(start, 8) + "-" + toHex(end, 8) + ". " +
                "Can't load binary at overlapping address range " + toHex(load_start, 8) + "-" + toHex(load_end, 8) + ". " +
                "Try changing the binary loading address.");
        }
      }
    }

    return this.checkCommand(ESP_MEM_BEGIN, this.pack('<IIII', size, blocks, blocksize, offset));
  }

  /**
   * @name memBlock (609)
   * Send a block of an image to RAM
   */
  async memBlock(data, seq) {
    return await this.checkCommand(
      ESP_MEM_DATA,
      this.pack('<IIII', data.length, seq, 0, 0).concat(data),
      this.checksum(data)
    );
  }

  /**
   * @name memFinish (615)
   * Leave download mode and run the application
   *
   * Sending ESP_MEM_END usually sends a correct response back, however sometimes
   * (with ROM loader) the executed code may reset the UART or change the baud rate
   * before the transmit FIFO is empty. So in these cases we set a short timeout and
   * ignore errors.
   */
  async memFinish(entrypoint=0) {
    let timeout = this.IS_STUB ? DEFAULT_TIMEOUT : MEM_END_ROM_TIMEOUT;
    let data = this.pack('<II', parseInt(entrypoint == 0), entrypoint);
    try {
      return await this.checkCommand(ESP_MEM_END, data, 0, timeout);
    } catch (e) {
      if (this.IS_STUB) {
        //  raise
      }
      // pass
    }
  }

  async getStubCode() {
    let response = await fetch('stubs/' + this.getStubFile() + '.json');
    let stubcode = await response.json();

    // Base64 decode the text and data
    stubcode.text = toByteArray(atob(stubcode.text));
    stubcode.data = toByteArray(atob(stubcode.data));
    return stubcode;
  }

  getStubFile() {
    if (this._chipfamily == ESP32) {
      return "esp32";
    } else if (this._chipfamily == ESP32S2) {
      return "esp32s2";
    } else if (this._chipfamily == ESP8266) {
      return "esp8266";
    }
  }

  // ESPTool Line 706
  async runStub(stub=null) {
    if (stub === null) {
      stub = await this.getStubCode();
    }

    // We're transferring over USB, right?
    let ramBlock = USB_RAM_BLOCK;

    // Upload
    logMsg("Uploading stub...")
    for (let field of ['text', 'data']) {
      if (Object.keys(stub).includes(field)) {
        let offset = stub[field + "_start"];
        let length = stub[field].length;
        let blocks = Math.floor((length + ramBlock - 1) / ramBlock);
        await this.memBegin(length, blocks, ramBlock, offset);
        for (let seq of Array(blocks).keys()) {
          let fromOffs = seq * ramBlock;
          let toOffs = fromOffs + ramBlock;
          if (toOffs > length) {
            toOffs = length;
          }
          await this.memBlock(stub[field].slice(fromOffs, toOffs), seq);
        }
      }
    }
    logMsg("Running stub...")
    await this.memFinish(stub['entry']);

    let p = await this.readBuffer(100);
    p = String.fromCharCode(...p);

    if (p != 'OHAI') {
      throw "Failed to start stub. Unexpected response: " + p;
    }
    logMsg("Stub running...");
    return new EspStubLoader();
  }
}

class EspStubLoader extends EspLoader {
  /*
    The Stubloader has commands that run on the uploaded Stub Code in RAM
    rather than built in commands.
  */
  constructor() {
    super();
    this.IS_STUB = true;
  }
  /**
   * @name getEraseSize
   * depending on flash chip model the erase may take this long (maybe longer!)
   */
  async eraseFlash() {
    await this.checkCommand(ESP_ERASE_FLASH, [], 0, CHIP_ERASE_TIMEOUT);
  };
}
