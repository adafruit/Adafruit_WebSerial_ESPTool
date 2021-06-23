/**
 * @name slipEncode
 * Take an array buffer and return back a new array where
 * 0xdb is replaced with 0xdb 0xdd and 0xc0 is replaced with 0xdb 0xdc
 */
export const slipEncode = (buffer: number[]): number[] => {
  let encoded: number[] = [];
  for (let byte of buffer) {
    if (byte == 0xdb) {
      encoded = encoded.concat([0xdb, 0xdd]);
    } else if (byte == 0xc0) {
      encoded = encoded.concat([0xdb, 0xdc]);
    } else {
      encoded.push(byte);
    }
  }
  return encoded;
};

/**
 * @name toByteArray
 * Convert a string to a byte array
 */
export const toByteArray = (str: string): number[] => {
  let byteArray: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let charcode = str.charCodeAt(i);
    if (charcode <= 0xff) {
      byteArray.push(charcode);
    }
  }
  return byteArray;
};

export const pack = (format: string, ...data: number[]) => {
  // let format = args[0];
  let pointer = 0;
  // let data = args.slice(1);
  if (format.replace(/[<>]/, "").length != data.length) {
    throw new Error("Pack format to Argument count mismatch");
  }
  let bytes: number[] = [];
  let littleEndian = true;

  const pushBytes = (value: number, byteCount: number) => {
    for (let i = 0; i < byteCount; i++) {
      if (littleEndian) {
        bytes.push((value >> (i * 8)) & 0xff);
      } else {
        bytes.push((value >> ((byteCount - i) * 8)) & 0xff);
      }
    }
  };

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
      throw new Error(`Unhandled character "${format[i]}" in pack format`);
    }
  }

  return bytes;
};

export const unpack = (format: string, bytes: number[]) => {
  let pointer = 0;
  let data = [];
  for (let c of format) {
    if (c == "B") {
      data.push(bytes[pointer] & 0xff);
      pointer += 1;
    } else if (c == "H") {
      data.push((bytes[pointer] & 0xff) | ((bytes[pointer + 1] & 0xff) << 8));
      pointer += 2;
    } else if (c == "I") {
      data.push(
        (bytes[pointer] & 0xff) |
          ((bytes[pointer + 1] & 0xff) << 8) |
          ((bytes[pointer + 2] & 0xff) << 16) |
          ((bytes[pointer + 3] & 0xff) << 24)
      );
      pointer += 4;
    } else {
      throw new Error(`Unhandled character "${c}" in unpack format`);
    }
  }
  return data;
};

export const toHex = (value: number, size = 2) => {
  let hex = value.toString(16).toUpperCase();
  if (hex.startsWith("-")) {
    return "-0x" + hex.substring(1).padStart(size, "0");
  } else {
    return "0x" + hex.padStart(size, "0");
  }
};

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
