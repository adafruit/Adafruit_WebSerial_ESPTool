'use strict';

let port;
let reader;
let inputStream;
let outputStream;
let inputBuffer = [];

const esp8266FlashSizes = {
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

const esp32FlashSizes = {
    "1MB": 0x00,
    "2MB": 0x10,
    "4MB": 0x20,
    "8MB": 0x30,
    "16MB": 0x40
};

const flashMode = {
    'qio': 0,
    'qout': 1,
    'dio': 2,
    'dout': 3
};

const flashFreq = {
    '40m': 0,
    '80m': 0xf
}

// Defaults
// Flash Frequency: 40m
// Flash Mode: qio
// Flash Size: 1MB

const ESP_ROM_BAUD = 115200;
const FLASH_WRITE_SIZE = 0x400;
const STUBLOADER_FLASH_WRITE_SIZE = 0x4000;
const FLASH_SECTOR_SIZE = 0x1000;  // Flash sector size, minimum unit of erase.

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

// Some comands supported by ESP32 ROM bootloader (or -8266 w/ stub)
const ESP_SPI_SET_PARAMS = 0x0B;
const ESP_SPI_ATTACH = 0x0D;
const ESP_READ_FLASH_SLOW  = 0x0E  // ROM only, much slower than the stub flash read
const ESP_CHANGE_BAUDRATE = 0x0F;
const ESP_FLASH_DEFL_BEGIN = 0x10
const ESP_FLASH_DEFL_DATA  = 0x11
const ESP_FLASH_DEFL_END   = 0x12
const ESP_SPI_FLASH_MD5 = 0x13;

// Commands supported by ESP32-S2/S3/C3/C6 ROM bootloader only
const ESP_GET_SECURITY_INFO = 0x14;

// Some commands supported by stub only
const ESP_ERASE_FLASH = 0xD0;
const ESP_ERASE_REGION = 0xD1;
const ESP_READ_FLASH = 0xD2;
const ESP_RUN_USER_CODE = 0xD3;

// Response code(s) sent by ROM
const ROM_INVALID_RECV_MSG = 0x05;

// Initial state for the checksum routine
const ESP_CHECKSUM_MAGIC = 0xEF;


const UART_DATE_REG_ADDR = 0x60000078;

const USB_RAM_BLOCK = 0x800;
const ESP_RAM_BLOCK = 0x1800;

// Timeouts
const DEFAULT_TIMEOUT = 3000;
const CHIP_ERASE_TIMEOUT = 120000;             // timeout for full chip erase in ms
const MAX_TIMEOUT = CHIP_ERASE_TIMEOUT * 2;    // longest any command can run in ms
const SYNC_TIMEOUT = 100;                      // timeout for syncing with bootloader in ms
const ERASE_REGION_TIMEOUT_PER_MB = 30000;     // timeout (per megabyte) for erasing a region in ms
const MEM_END_ROM_TIMEOUT = 500;


const magicValues = {
    "ESP8266": { "chipId": ESP8266, "magicVal": 0xfff0c101},
    "ESP32":  { "chipId": ESP32, "magicVal": 0x00f01d83},
    "ESP32S2": { "chipId": ESP32S2, "magicVal": 0x000007c6}
}


class EspLoader {
  constructor(params) {
    this._chipfamily = null;
    this.readTimeout = 3000;  // Arbitrary number for now. This should be set more dynamically in the sendCommand function
    this._efuses = new Array(4).fill(0);
    this._flashsize = 4 * 1024 * 1024;
    if (this.isFunction(params.updateProgress)) {
      this.updateProgress = params.updateProgress
    } else {
      this.updateProgress = null
    }

    if (this.isFunction(params.logMsg)) {
      this.logMsg = params.logMsg
    } else {
      this.logMsg = console.log
    }
    this.debug = false;
    if (this.isFunction(params.debugMsg)) {
      if (params.debug !== false) {
        this.debug = true;
      }
      this._debugMsg = params.debugMsg
    } else {
      this._debugMsg = this.logMsg()
    }
    this.IS_STUB = false;
    this.syncStubDetected = false;
  }

  isFunction(functionObj) {
    return functionObj && {}.toString.call(functionObj) === '[object Function]';
  }

  toHex(value, size=2) {
    return "0x" + value.toString(16).toUpperCase().padStart(size, "0");
  }

  getChromeVersion() {
    let raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./);

    return raw ? parseInt(raw[2], 10) : false;
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

  debugMsg(...values) {
    if (this.debug) {
      this._debugMsg(...values);
    }
  }

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
      this.debugMsg("Reading Register", reg);
    }
    let packet = struct.pack("I", reg);
    return (await this.checkCommand(ESP_READ_REG, packet))[0];
  };

  /**
   * @name writeRegister
   * Write to a register within the ESP chip RAM, returns a 4-element list
   */
  async writeRegister(reg, value) {
    if (this.debug) {
      this.debugMsg("Reading Register", reg);
    }
    let packet = struct.pack("I", reg);
    return (await this.checkCommand(ESP_READ_REG, packet))[0];
  };

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * @name chipType
   * ESP32 or ESP8266 based on which chip type we're talking to
   */
  async chipType() {
    if (this._chipfamily === null) {
      this._chipfamily = await this.detectChip()
    }
    return this._chipfamily;
  };


  async detectChip() {
    let chipMagicValue = await this.readRegister(CHIP_DETECT_MAGIC_REG_ADDR);

    // Loop through magicValues and i f the value matches, then the key is the chip ID
    for (const [key, value] of Object.entries(magicValues)) {
      if (chipMagicValue == value["magicVal"]) {
        return value["chipId"]
      }
    }
    throw("Unable to detect Chip");
  }


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
      this.debugMsg("status", status);
      this.debugMsg("value", value);
      this.debugMsg("data", data);
    }
    if (status[0] == 1) {
      if (status[1] == ROM_INVALID_RECV_MSG) {
        throw("Invalid (unsupported) command " + this.toHex(opcode));
      } else {
        throw("Command failure error code " + this.toHex(status[1]));
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
    //this.debugMsg("Running Send Command");
    inputBuffer = []; // Reset input buffer
    let packet = [0xC0, 0x00];  // direction
    packet.push(opcode);
    packet = packet.concat(struct.pack("H", buffer.length));
    packet = packet.concat(this.slipEncode(struct.pack("I", checksum)));
    packet = packet.concat(this.slipEncode(buffer));
    packet.push(0xC0);
    this._debugMsg("Writing " + packet.length + " byte" + (packet.length == 1 ? "" : "s") + ":", packet);
    await this.writeToStream(packet);
  };

  /**
   * @name connect
   * Opens a Web Serial connection to a micro:bit and sets up the input and
   * output stream.
   */
  async connect() {
    // - Request a port and open a connection.
    port = await navigator.serial.requestPort();

    // - Wait for the port to open.toggleUIConnected
    if (this.getChromeVersion() < 86) {
      await port.open({ baudrate: ESP_ROM_BAUD });
    } else {
      await port.open({ baudRate: ESP_ROM_BAUD });
    }

    const signals = await port.getSignals();

    this.logMsg("Connected successfully.")

    this.logMsg("Try to reset.")
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    await new Promise(resolve => setTimeout(resolve, 1000));

    outputStream = port.writable;
    inputStream = port.readable;
  }

  connected() {
    if (port) {
      return true;
    }
    return false;
  }

  /**
   * @name disconnect
   * Closes the Web Serial connection.
   */
  async disconnect() {
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
   * @name writeToStream
   * Gets a writer from the output stream and send the raw data over WebSerial.
   */
  async writeToStream(data) {
    const writer = outputStream.getWriter();
    await writer.write(new Uint8Array(data));
    writer.releaseLock();
  }

  hexFormatter(bytes) {
    return "[" + bytes.map(value => this.toHex(value)).join(", ") + "]"
  }

  /**
   * @name readPacket
   * Generator to read SLIP packets from a serial port.
   * Yields one full SLIP packet at a time, raises exception on timeout or invalid data.
   * Designed to avoid too many calls to serial.read(1), which can bog
   * down on slow systems.
   */

  async readPacket() {
    let partialPacket = null;
    let inEscape = false;
    let readBytes = [];
    while (true) {
        let stamp = Date.now();
        readBytes = [];
        while (Date.now() - stamp < this.readTimeout) {
            if (inputBuffer.length > 0) {
              readBytes.push(inputBuffer.shift());
              break;
            } else {
                await this.sleep(10);
            }
        }
        if (readBytes.length == 0) {
            let waitingFor = partialPacket === null ? "header" : "content";
            this.debugMsg("Timed out waiting for packet " + waitingFor);
            throw new SlipReadError("Timed out waiting for packet " + waitingFor);
        }
        this._debugMsg("Read " + readBytes.length + " bytes: " + this.hexFormatter(readBytes));
        for (let b of readBytes) {
            if (partialPacket === null) {  // waiting for packet header
                if (b == 0xc0) {
                    partialPacket = [];
                } else {
                    this.debugMsg("Read invalid data: " + this.hexFormatter(readBytes));
                    this.debugMsg("Remaining data in serial buffer: " + this.hexFormatter(inputBuffer));
                    throw new SlipReadError('Invalid head of packet (' + this.toHex(b) + ')');
                }
            } else if (inEscape) {  // part-way through escape sequence
                inEscape = false;
                if (b == 0xdc) {
                    partialPacket.push(0xc0);
                } else if (b == 0xdd) {
                    partialPacket.push(0xdb);
                } else {
                    this.debugMsg("Read invalid data: " + this.hexFormatter(readBytes));
                    this.debugMsg("Remaining data in serial buffer: " + this.hexFormatter(inputBuffer));
                    throw new SlipReadError('Invalid SLIP escape (0xdb, ' + this.toHex(b) + ')');
                }
            } else if (b == 0xdb) {  // start of escape sequence
                inEscape = true;
            } else if (b == 0xc0) {  // end of packet
                this._debugMsg("Received full packet: " + this.hexFormatter(partialPacket))
                return partialPacket;
                partialPacket = null;
            } else {  // normal byte in packet
                partialPacket.push(b);
            }
        }
      }
    return '';
  }

  /**
   * @name getResponse
   * Read response data and decodes the slip packet, then parses
   * out the value/data and returns as a tuple of (value, data) where
   * each is a list of bytes
   */
  async getResponse(opcode, timeout=DEFAULT_TIMEOUT) {
    this.readTimeout = timeout;
    let packet;
    let packetLength = 0;
    let resp, opRet, lenRet, val, data;
    for (let i = 0; i < 100; i++) {
        try {
          packet = await this.readPacket();
        } catch(e) {
          this.logMsg("Timed out after " + this.readTimeout + " milliseconds");
          return [null, null];
        }

        if (packet.length < 8) {
          continue;
        }

        [resp, opRet, lenRet, val] = struct.unpack('<BBHI', packet.slice(0, 8));
        if (resp != 1) {
          continue;
        }
        data = packet.slice(8);
        if (opcode == null || opRet == opcode) {
            return [val, data];
        }
        if (data[0] != 0 && data[1] == ROM_INVALID_RECV_MSG) {
          //inputBuffer = [];
          throw("Invalid (unsupported) command " + this.toHex(opcode));
        }
    }
    throw("Response doesn't match request");
  };

/**
   * @name read
   * Read response data and decodes the slip packet.
   * Keeps reading until we hit the timeout or get
   * a packet closing byte
   */
  async readBuffer(timeout=DEFAULT_TIMEOUT) {
    this.readTimeout = timeout;
    let packet;
    try {
      packet = await this.readPacket();
    } catch(e) {
      this.logMsg("Timed out after " + this.readTimeout + " milliseconds");
      return null;
    }

    return packet;
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

  setPortBaudRate(baud) {
    if (this.getChromeVersion() < 86) {
      port.baudrate = baud;
    } else {
      port.baudRate = baud;
    }
  }

  getPortBaudRate() {
    if (this.getChromeVersion() < 86) {
      return port.baudrate;
    }
    return port.baudRate;
  }

  async setBaudrate(baud) {
    if (this._chipfamily == ESP8266) {
      this.logMsg("Baud rate can only change on ESP32 and ESP32-S2");
    } else {
      this.logMsg("Attempting to change baud rate to " + baud + "...");
      try {
        // stub takes the new baud rate and the old one
        let oldBaud = this.IS_STUB ? this.getPortBaudRate() : 0;
        let buffer = struct.pack("<II", baud, oldBaud);
        await this.checkCommand(ESP_CHANGE_BAUDRATE, buffer);
        this.setPortBaudRate(baud);
        await this.sleep(50);
        //inputBuffer = [];
        this.logMsg("Changed baud rate to " + baud);
      } catch (e) {
        throw("Unable to change the baud rate, please try setting the connection speed from " + baud + " to 115200 and reconnecting.");
      }
    }
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
        await this.sleep(100);
        return true;
      }
      await this.sleep(100);
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
    let [reply, data] = await this.getResponse(ESP_SYNC, SYNC_TIMEOUT);
    this.syncStubDetected = reply == 0;
    for (let i = 0; i < 8; i++) {
      let [reply, data] = await this.getResponse(ESP_SYNC, SYNC_TIMEOUT);
      this.syncStubDetected &= reply == 0;
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
      return FLASH_WRITE_SIZE;
  };

  /**
   * @name flashData
   * Program a full, uncompressed binary file into SPI Flash at
   *   a given offset. If an ESP32 and md5 string is passed in, will also
   *   verify memory. ESP8266 does not have checksum memory verification in
   *   ROM
   */
  async flashData(binaryData, offset=0, part=0) {
    let filesize = binaryData.byteLength;
    this.logMsg("\nWriting data with filesize: " + filesize);
    let blocks = await this.flashBegin(filesize, offset);
    let block = [];
    let seq = 0;
    let written = 0;
    let address = offset;
    let position = 0;
    let stamp = Date.now();
    let flashWriteSize = this.getFlashWriteSize();

    while (filesize - position > 0) {
      let percentage = Math.floor(100 * (seq + 1) / blocks);
      /*this.logMsg(
          "Writing at " + this.toHex(address + seq * flashWriteSize, 8) + "... (" + percentage + " %)"
      );*/
      if (this.updateProgress !== null) {
        this.updateProgress(part, percentage);
      }
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
    this.logMsg("Took " + (Date.now() - stamp) + "ms to write " + filesize + " bytes");
  };

  /**
   * @name flashBlock
   * Send one block of data to program into SPI Flash memory
   */
  async flashBlock(data, seq, timeout=100) {
    await this.checkCommand(
      ESP_FLASH_DATA,
      struct.pack("<IIII", data.length, seq, 0, 0).concat(data),
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
    let buffer;
    let flashWriteSize = this.getFlashWriteSize();
    if ([ESP32, ESP32S2].includes(this._chipfamily)) {
      await this.checkCommand(ESP_SPI_ATTACH, new Array(8).fill(0));
    }
    if (this._chipfamily == ESP32) {
      // We are hardcoded for 4MB flash on ESP32
      buffer = struct.pack(
          "<IIIIII", 0, this._flashsize, 0x10000, 4096, 256, 0xFFFF
      )
      await this.checkCommand(ESP_SPI_SET_PARAMS, buffer);
    }
    let numBlocks = Math.floor((size + flashWriteSize - 1) / flashWriteSize);
    let eraseSize = this.getEraseSize(offset, size);

    let timeout;
    if (this.IS_STUB) {
      timeout = DEFAULT_TIMEOUT;
    } else {
      timeout = this.timeoutPerMb(ERASE_REGION_TIMEOUT_PER_MB, size);
    }

    let stamp = Date.now();
    buffer = struct.pack(
        "<IIII", eraseSize, numBlocks, flashWriteSize, offset
    );
    if ([ESP32S2].includes(this._chipfamily) && !this.IS_STUB) {
      buffer = buffer.concat(struct.pack(
        "<I", encrypted ? 1 : 0
      ));
    }
    this.logMsg(
        "Erase size " + eraseSize + ", blocks " + numBlocks + ", block size " + flashWriteSize + ", offset " + this.toHex(offset, 4) + ", encrypted " + (encrypted ? "yes" : "no")
    );
    await this.checkCommand(ESP_FLASH_BEGIN, buffer, 0, timeout);
    if (size != 0 && !this.IS_STUB) {
      this.logMsg("Took " + (Date.now() - stamp) + "ms to erase " + numBlocks + " bytes");
    }
    return numBlocks;
  };

  async flashFinish() {
    let buffer = struct.pack('<I', 1);
    await this.checkCommand(ESP_FLASH_END, buffer);
  };

  /**
   * @name getEraseSize
   * Calculate an erase size given a specific size in bytes.
   *   Provides a workaround for the bootloader erase bug on ESP8266.
   */
  getEraseSize(offset, size) {
    if (this._chipfamily != ESP8266 || this.IS_STUB) {
      return size;
    }
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
          throw("Software loader is resident at " + this.toHex(start, 8) + "-" + this.toHex(end, 8) + ". " +
                "Can't load binary at overlapping address range " + this.toHex(load_start, 8) + "-" + this.toHex(load_end, 8) + ". " +
                "Try changing the binary loading address.");
        }
      }
    }

    return this.checkCommand(ESP_MEM_BEGIN, struct.pack('<IIII', size, blocks, blocksize, offset));
  }

  /**
   * @name memBlock (609)
   * Send a block of an image to RAM
   */
  async memBlock(data, seq) {
    return await this.checkCommand(
      ESP_MEM_DATA,
      struct.pack('<IIII', data.length, seq, 0, 0).concat(data),
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
    let data = struct.pack('<II', parseInt(entrypoint == 0), entrypoint);
    try {
      return await this.checkCommand(ESP_MEM_END, data, 0, timeout);
    } catch (e) {
      if (this.IS_STUB) {
        throw(e);
      }
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

  getStubLoaderClass() {
    // Based on current chip, we return the appropriate stub loader class
  }

  getRomClass() {
    // Based on current chip, we return the appropriate Rom class
  }

  async runStub(stub=null) {
    if (stub === null) {
      stub = await this.getStubCode();
    }

    if (this.syncStubDetected) {
        this.logMsg("Stub is already running. No upload is necessary.");
        return this.stubClass;
    }

    let ramBlock = ESP_RAM_BLOCK;
    // We're transferring over USB, right?
    if ([ESP32S2].includes(this._chipfamily)) {
      ramBlock = USB_RAM_BLOCK;
    }

    // Upload
    this.logMsg("Uploading stub...")
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
    this.logMsg("Running stub...")
    await this.memFinish(stub['entry']);

    let p = await this.readBuffer(100);
    p = String.fromCharCode(...p);

    if (p != 'OHAI') {
      throw "Failed to start stub. Unexpected response: " + p;
    }
    this.logMsg("Stub is now running...");
    this.stubClass = new EspStubLoader({
      updateProgress: this.updateProgress,
      logMsg: this.logMsg,
      debugMsg: this._debugMsg,
      debug: this.debug,
    });
    return this.stubClass;
  }
}

class EspStubLoader extends EspLoader {
  /*
    The Stubloader has commands that run on the uploaded Stub Code in RAM
    rather than built in commands.
  */
  constructor(params) {
    super(params);
    this.IS_STUB = true;
  }
  /**
   * @name eraseFlash
   * depending on flash chip model the erase may take this long (maybe longer!)
   */
  async eraseFlash() {
    await this.checkCommand(ESP_ERASE_FLASH, [], 0, CHIP_ERASE_TIMEOUT);
  };

  /**
   * @name getFlashWriteSize
   * Get the Flash write size based on the chip
   */
  getFlashWriteSize() {
      return STUBLOADER_FLASH_WRITE_SIZE;
  };
}

/*
Represents error when NVS Partition size given is insufficient
to accomodate the data in the given csv file
*/
class SlipReadError extends Error {
    constructor(message) {
        super(message);
        this.name = "SlipReadError";
    }
}
