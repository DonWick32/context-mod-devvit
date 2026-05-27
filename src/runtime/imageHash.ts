import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

interface BlockImageData {
  data: Uint8Array | Buffer;
  width: number;
  height: number;
}

const one_bits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

export const hammingDistance = (hash1: string, hash2: string): number => {
  let d = 0;
  if (hash1.length !== hash2.length) {
    throw new Error("Can't compare hashes with different length");
  }
  for (let i = 0; i < hash1.length; i++) {
    const n1 = parseInt(hash1[i]!, 16);
    const n2 = parseInt(hash2[i]!, 16);
    d += one_bits[n1 ^ n2]!;
  }
  return d;
};

export const hashSimilarityPercent = (hash1: string, hash2: string): number => {
  const distance = hammingDistance(hash1, hash2);
  const totalBits = hash1.length * 4;
  return ((totalBits - distance) / totalBits) * 100;
};

const median = (data: number[]): number => {
  const mdarr = data.slice(0).sort((a, b) => a - b);
  if (mdarr.length % 2 === 0) {
    return (mdarr[mdarr.length / 2 - 1]! + mdarr[mdarr.length / 2]!) / 2.0;
  }
  return mdarr[Math.floor(mdarr.length / 2)]!;
};

const translate_blocks_to_bits = (blocks: number[], pixels_per_block: number) => {
  const half_block_value = (pixels_per_block * 256 * 3) / 2;
  const bandsize = blocks.length / 4;

  for (let i = 0; i < 4; i++) {
    const m = median(blocks.slice(i * bandsize, (i + 1) * bandsize));
    for (let j = i * bandsize; j < (i + 1) * bandsize; j++) {
      const v = blocks[j]!;
      blocks[j] = Number(v > m || (Math.abs(v - m) < 1 && m > half_block_value));
    }
  }
};

const bits_to_hexhash = (bitsArray: number[]): string => {
  const hex = [];
  for (let i = 0; i < bitsArray.length; i += 4) {
    const nibble = bitsArray.slice(i, i + 4);
    hex.push(parseInt(nibble.join(''), 2).toString(16));
  }
  return hex.join('');
};

const bmvbhash_even = (
  data: BlockImageData,
  bits: number,
  calculateFlipped = false
): string | [string, string] => {
  const blocksize_x = Math.floor(data.width / bits);
  const blocksize_y = Math.floor(data.height / bits);
  const result: number[] = [];

  for (let y = 0; y < bits; y++) {
    for (let x = 0; x < bits; x++) {
      let total = 0;
      for (let iy = 0; iy < blocksize_y; iy++) {
        for (let ix = 0; ix < blocksize_x; ix++) {
          const cx = x * blocksize_x + ix;
          const cy = y * blocksize_y + iy;
          const ii = (cy * data.width + cx) * 4;
          const alpha = data.data[ii + 3];
          if (alpha === 0) {
            total += 765;
          } else {
            total += data.data[ii]! + data.data[ii + 1]! + data.data[ii + 2]!;
          }
        }
      }
      result.push(total);
    }
  }

  if (calculateFlipped) {
    const resultFlip: number[] = [];
    for (let i = 0; i < bits; i++) {
      for (let j = 0; j < bits; j++) {
        resultFlip.push(result[i * bits + (bits - 1 - j)]!);
      }
    }
    translate_blocks_to_bits(result, blocksize_x * blocksize_y);
    translate_blocks_to_bits(resultFlip, blocksize_x * blocksize_y);
    return [bits_to_hexhash(result), bits_to_hexhash(resultFlip)];
  } else {
    translate_blocks_to_bits(result, blocksize_x * blocksize_y);
    return bits_to_hexhash(result);
  }
};

const bmvbhash = (
  data: BlockImageData,
  bits: number,
  calculateFlipped = false
): string | [string, string] => {
  const even_x = data.width % bits === 0;
  const even_y = data.height % bits === 0;

  if (even_x && even_y) {
    return bmvbhash_even(data, bits, calculateFlipped);
  }

  const blocks: number[][] = Array.from({ length: bits }, () => Array(bits).fill(0));
  const block_width = data.width / bits;
  const block_height = data.height / bits;

  for (let y = 0; y < data.height; y++) {
    let block_top: number, block_bottom: number;
    let weight_top: number, weight_bottom: number;

    if (even_y) {
      block_top = block_bottom = Math.floor(y / block_height);
      weight_top = 1;
      weight_bottom = 0;
    } else {
      const y_mod = (y + 1) % block_height;
      const y_frac = y_mod - Math.floor(y_mod);
      const y_int = y_mod - y_frac;
      weight_top = 1 - y_frac;
      weight_bottom = y_frac;

      if (y_int > 0 || y + 1 === data.height) {
        block_top = block_bottom = Math.floor(y / block_height);
      } else {
        block_top = Math.floor(y / block_height);
        block_bottom = Math.ceil(y / block_height);
      }
    }

    for (let x = 0; x < data.width; x++) {
      let block_left: number, block_right: number;
      let weight_left: number, weight_right: number;

      if (even_x) {
        block_left = block_right = Math.floor(x / block_width);
        weight_left = 1;
        weight_right = 0;
      } else {
        const x_mod = (x + 1) % block_width;
        const x_frac = x_mod - Math.floor(x_mod);
        const x_int = x_mod - x_frac;
        weight_left = 1 - x_frac;
        weight_right = x_frac;

        if (x_int > 0 || x + 1 === data.width) {
          block_left = block_right = Math.floor(x / block_width);
        } else {
          block_left = Math.floor(x / block_width);
          block_right = Math.ceil(x / block_width);
        }
      }

      const ii = (y * data.width + x) * 4;
      const alpha = data.data[ii + 3];
      const avgvalue =
        alpha === 0 ? 765 : data.data[ii]! + data.data[ii + 1]! + data.data[ii + 2]!;

      blocks[block_top]![block_left]! += avgvalue * weight_top * weight_left;
      blocks[block_top]![block_right]! += avgvalue * weight_top * weight_right;
      blocks[block_bottom]![block_left]! += avgvalue * weight_bottom * weight_left;
      blocks[block_bottom]![block_right]! += avgvalue * weight_bottom * weight_right;
    }
  }

  if (calculateFlipped) {
    const result: number[] = [];
    const resultFlip: number[] = [];
    for (let i = 0; i < bits; i++) {
      for (let j = 0; j < bits; j++) {
        result.push(blocks[i]![j]!);
        resultFlip.push(blocks[i]![bits - 1 - j]!);
      }
    }
    translate_blocks_to_bits(result, block_width * block_height);
    translate_blocks_to_bits(resultFlip, block_width * block_height);
    return [bits_to_hexhash(result), bits_to_hexhash(resultFlip)];
  } else {
    const result: number[] = [];
    for (let i = 0; i < bits; i++) {
      for (let j = 0; j < bits; j++) {
        result.push(blocks[i]![j]!);
      }
    }
    translate_blocks_to_bits(result, block_width * block_height);
    return bits_to_hexhash(result);
  }
};

const decodeImage = (buffer: Uint8Array, mimeType: string): BlockImageData => {
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    const rawImageData = jpeg.decode(buffer, { useTArray: true });
    return {
      data: rawImageData.data,
      width: rawImageData.width,
      height: rawImageData.height,
    };
  } else if (mimeType === 'image/png') {
    const png = PNG.sync.read(Buffer.from(buffer));
    return {
      data: png.data,
      width: png.width,
      height: png.height,
    };
  } else {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }
};

export const computeImageHash = (
  buffer: Uint8Array,
  mimeType: string,
  bits = 16
): string => {
  const imgData = decodeImage(buffer, mimeType);
  return bmvbhash(imgData, bits, false) as string;
};

export const computeImageHashAndFlipped = (
  buffer: Uint8Array,
  mimeType: string,
  bits = 16
): [string, string] => {
  const imgData = decodeImage(buffer, mimeType);
  return bmvbhash(imgData, bits, true) as [string, string];
};
