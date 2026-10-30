const EMPTY_VALUE = "\x00\x00\x00\x00";

function removeNullTermination(string) {
  while (string.endsWith("\0")) string = string.slice(0, -1);
  return string;
}

function normalizeString(string) {
  // remove remaining spaces (need to be after null termination!)
  string = removeNullTermination(string).trim();
  return string === "" ? undefined : string;
}

const arrayToCharCode = (arr) => String.fromCharCode.apply(null, arr);

const utf8decoder = new TextDecoder("utf-8");

function uint8ArrayToUtf8String(uint8array) {
  return utf8decoder.decode(uint8array);
}

class BufferView {
  declare dataView: DataView;
  declare buffer: ArrayBufferLike;
  declare byteOffset: number;
  declare byteLength: number;

  constructor(arg: Uint8Array, offset = 0, length?) {
    // Node.js Buffer is also instance of Uint8Array, but small ones are backed
    // by single large ArrayBuffer pool, so we always need to check for arg.byteOffset.
    if (length === undefined) length = arg.byteLength - offset;
    offset += arg.byteOffset;
    if (offset + length > arg.byteOffset + arg.byteLength)
      throw new Error(
        "Creating view outside of available memory in ArrayBuffer",
      );
    const dataView = new DataView(arg.buffer, offset, length);
    this.dataView = dataView;
    this.buffer = dataView.buffer;
    this.byteOffset = dataView.byteOffset;
    this.byteLength = dataView.byteLength;
  }

  // Use this for reading data.
  // Returns Uint8Array from given point in the chunk. Properly start at the begining of the chunk,
  // regardles of where the chunk is in the ArrayBuffer.
  getUint8Array(offset, length) {
    return new Uint8Array(this.buffer, this.byteOffset + offset, length);
  }

  getString(offset = 0, length = this.byteLength) {
    const arr = this.getUint8Array(offset, length);
    return uint8ArrayToUtf8String(arr);
  }

  // TODO: refactor
  getUnicodeString(offset = 0, length = this.byteLength) {
    // cannot use Uint16Array because it uses the other endian order.
    const chars: number[] = [];
    for (let i = 0; i < length && offset + i < this.byteLength; i += 2)
      chars.push(this.getUint16(offset + i));
    return arrayToCharCode(chars);
  }

  getInt8(offset) {
    return this.dataView.getInt8(offset);
  }
  getUint8(offset) {
    return this.dataView.getUint8(offset);
  }
  // ICC uses big-endian so we hard-code littleEndian=false for all of these.
  getInt16(offset) {
    return this.dataView.getInt16(offset, false);
  }
  getInt32(offset) {
    return this.dataView.getInt32(offset, false);
  }
  getUint16(offset) {
    return this.dataView.getUint16(offset, false);
  }
  getUint32(offset) {
    return this.dataView.getUint32(offset, false);
  }
}

class IccParser {
  raw: Map<number | string, unknown>;
  chunk: BufferView;

  constructor(chunk) {
    this.chunk = new BufferView(chunk);
  }

  parse() {
    this.raw = new Map();
    this.parseHeader();
    this.parseTags();
    return this.translate();
  }

  parseHeader() {
    const { raw } = this;
    if (this.chunk.byteLength < 84) throw new Error("ICC header is too short");
    for (const [offsetKey, parse] of Object.entries(headerParsers)) {
      const offset = parseInt(offsetKey, 10);
      const val = (parse as (chunk: BufferView, offset: number) => unknown)(
        this.chunk,
        offset,
      );
      if (val === EMPTY_VALUE) continue;
      raw.set(offset, val);
    }
  }

  parseTags() {
    const { raw } = this;
    let tagCount = this.chunk.getUint32(128);
    let offset = 132;
    const chunkLength = this.chunk.byteLength;
    let code, valueOffset, valueLength, ttype, value;
    while (tagCount--) {
      code = this.chunk.getString(offset, 4);
      valueOffset = this.chunk.getUint32(offset + 4);
      valueLength = this.chunk.getUint32(offset + 8);
      ttype = this.chunk.getString(valueOffset, 4);
      if (valueOffset + valueLength > chunkLength) {
        throw new Error("Corrupt ICC profile data");
      }
      value = this.parseTag(ttype, valueOffset);
      raw.set(code, value);
      offset += 12;
    }
  }

  parseTag(ttype, offset) {
    switch (ttype) {
      case "mluc":
        return this.parseMluc(offset);
      case "para":
        return this.parsePara(offset);
    }
    throw new Error(`Unhandled ICC tag data type: "${ttype}"`);
  }

  // Multi Localized Unicode Type
  parseMluc(tagOffset) {
    const { chunk } = this;
    const entryCount = chunk.getUint32(tagOffset + 8);
    const entrySize = chunk.getUint32(tagOffset + 12);
    let entryOffset = tagOffset + 16;
    const values: { lang: string; country: string; text: string }[] = [];
    for (let i = 0; i < entryCount; i++) {
      const lang = chunk.getString(entryOffset + 0, 2);
      const country = chunk.getString(entryOffset + 2, 2);
      const length = chunk.getUint32(entryOffset + 4);
      const offset = chunk.getUint32(entryOffset + 8) + tagOffset;
      const text = normalizeString(chunk.getUnicodeString(offset, length));
      values.push({ lang, country, text });
      entryOffset += entrySize;
    }
    if (entryCount === 1) return values[0].text;
    else return values;
  }

  // Parametric Curve Type
  parsePara(offset) {
    const { chunk } = this;
    const functionType = chunk.getUint16(offset + 8);
    const g = parseS15Fixed16Number(chunk, offset + 12);
    let a = 0,
      b = 0,
      c = 0,
      d = 0,
      e = 0,
      f = 0;
    if (functionType >= 1) {
      a = parseS15Fixed16Number(chunk, offset + 16);
      b = parseS15Fixed16Number(chunk, offset + 20);
    }
    if (functionType >= 2) {
      c = parseS15Fixed16Number(chunk, offset + 24);
    }
    if (functionType >= 3) {
      d = parseS15Fixed16Number(chunk, offset + 28);
    }
    if (functionType >= 4) {
      e = parseS15Fixed16Number(chunk, offset + 32);
      f = parseS15Fixed16Number(chunk, offset + 36);
    }
    const values = { functionType, g, a, b, c, d, e, f };
    return values;
  }

  translate() {
    const { raw } = this;
    const output = {};
    for (const [key, val] of raw) {
      if (!headerAndTagNames.has(key)) {
        throw new Error(`Unsupported ICC tag: ${key}`);
      }
      output[headerAndTagNames.get(key)] = val;
    }
    return output;
  }
}

const headerAndTagNames = new Map<number | string, string>([
  [4, "ProfileCMMType"],
  [8, "ProfileVersion"],
  [12, "ProfileClass"],
  [16, "ColorSpaceData"],
  [20, "ProfileConnectionSpace"],
  [24, "ProfileDateTime"],
  [36, "ProfileFileSignature"],
  [40, "PrimaryPlatform"],
  [44, "CMMFlags"],
  [48, "DeviceManufacturer"],
  [52, "DeviceModel"],
  [56, "DeviceAttributes"],
  [64, "RenderingIntent"],
  [68, "ConnectionSpaceIlluminant"],
  [80, "ProfileCreator"],
  [84, "ProfileID"],
  ["desc", "ProfileDescription"],
  ["cprt", "ProfileCopyright"],
  ["kTRC", "GrayTRC"],
]);

const headerParsers = {
  4: parseString,
  8: parseVersion,
  12: parseString,
  16: parseString,
  20: parseString,
  24: parseDate,
  36: parseString,
  40: parseString,
  48: parseString,
  52: parseString,
  64: (view, offset) => view.getUint32(offset),
  80: parseString,
};

function parseString(view, offset) {
  return normalizeString(view.getString(offset, 4));
}

function parseVersion(view, offset) {
  return [
    view.getUint8(offset),
    view.getUint8(offset + 1) >> 4,
    view.getUint8(offset + 1) % 16,
  ];
}

function parseDate(view, offset) {
  const year = view.getUint16(offset);
  const month = view.getUint16(offset + 2) - 1;
  const day = view.getUint16(offset + 4);
  const hours = view.getUint16(offset + 6);
  const minutes = view.getUint16(offset + 8);
  const seconds = view.getUint16(offset + 10);
  return new Date(Date.UTC(year, month, day, hours, minutes, seconds));
}

function parseS15Fixed16Number(view, offset) {
  const integer = view.getInt16(offset);
  const fractional = view.getUint16(offset + 2);
  return integer + fractional / 65536;
}

export function parseIccProfile(content: Uint8Array) {
  const parser = new IccParser(content);
  return parser.parse();
}
