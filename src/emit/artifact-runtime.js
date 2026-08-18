/**
 * The code that runs inside the emitted artifact, before the presentation
 * runtime does.
 *
 * These functions are not called from the studio. They are serialized — with
 * `Function.prototype.toString()`, so what ships is exactly what is tested —
 * into the artifact's boot script by `emit/document.js`. Writing them as real
 * modules rather than as a template string is the whole point: every one of
 * them is unit-tested in `test/emit/artifact-runtime.test.mjs` against the same
 * `src/core/deflate.js` output the emitter produces, so the artifact's decode
 * path is covered by ordinary tests instead of by hope.
 *
 * Three constraints hold for everything in this file:
 *
 *   1. **Self-contained.** No imports, no closure over module scope, no
 *      optional chaining or syntax an older engine would reject — an artifact
 *      is opened on whatever laptop is in the room.
 *   2. **Survives the scanner.** No network identifiers, no absolute URLs, no
 *      `eval`. `test/emit/scanner-selfcheck.test.mjs` runs the scanner over the
 *      serialized source and asserts zero findings.
 *   3. **Claims nothing.** §18.5: nothing here says a capability was performed
 *      live, because nothing here performs one.
 *
 * @module emit/artifact-runtime
 */

/**
 * Decode standard base64 to bytes.
 *
 * The artifact carries its model and its media as base64 and nothing else, so
 * this is the only decoder it needs. `atob` is used when present because it is
 * an order of magnitude faster on a multi-megabyte payload and the cold-boot
 * budget is 1.5s (§12); the manual path keeps the artifact working where it is
 * not.
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export function ppBase64ToBytes(text) {
  var clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof atob === 'function') {
    var bin = atob(clean);
    var fast = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) fast[k] = bin.charCodeAt(k);
    return fast;
  }
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var lookup = new Int16Array(256);
  for (var t = 0; t < 256; t++) lookup[t] = -1;
  for (var c = 0; c < alphabet.length; c++) lookup[alphabet.charCodeAt(c)] = c;
  var out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  var o = 0;
  var acc = 0;
  var bits = 0;
  for (var i = 0; i < clean.length; i++) {
    var v = lookup[clean.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, o);
}

/**
 * Raw DEFLATE decompression (RFC 1951) — the fallback path.
 *
 * D5 has the artifact inflate with the platform `DecompressionStream`, which
 * costs no bytes. That API is missing on browsers still in real use (Safari
 * before 16.4, Firefox before 113), and §13 requires the file to open when it
 * is forwarded as an email attachment and double-clicked on whatever machine
 * receives it. So the artifact carries this, and its bytes are counted against
 * the compressed variant when the emitter decides whether compression is
 * actually smaller — see `emit/model.js`.
 *
 * All three block types are handled, stored blocks included, which is the path
 * `test/emit/compression.test.mjs` exercises explicitly.
 *
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
export function ppInflateRaw(input) {
  var out = new Uint8Array(Math.max(1024, input.length * 4));
  var outLen = 0;
  var pos = 0;
  var bitBuf = 0;
  var bitCount = 0;

  function grow(extra) {
    if (outLen + extra <= out.length) return;
    var cap = out.length * 2;
    while (cap < outLen + extra) cap *= 2;
    var next = new Uint8Array(cap);
    next.set(out.subarray(0, outLen));
    out = next;
  }
  function bits(n) {
    while (bitCount < n) {
      if (pos >= input.length) throw new Error('inflate: out of input');
      bitBuf |= input[pos++] << bitCount;
      bitCount += 8;
    }
    var v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return v;
  }
  function buildTree(lengths) {
    var maxBits = 0;
    var i;
    for (i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
    var counts = new Int32Array(maxBits + 1);
    for (i = 0; i < lengths.length; i++) if (lengths[i]) counts[lengths[i]]++;
    var symbols = new Int32Array(lengths.length);
    var offsets = new Int32Array(maxBits + 2);
    var total = 0;
    for (i = 1; i <= maxBits; i++) { offsets[i] = total; total += counts[i]; }
    for (i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
    return { counts: counts, symbols: symbols, maxBits: maxBits };
  }
  function decodeSymbol(tree) {
    var code = 0;
    var first = 0;
    var index = 0;
    for (var len = 1; len <= tree.maxBits; len++) {
      code |= bits(1);
      var count = tree.counts[len];
      if (code - first < count) return tree.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: bad code');
  }

  var lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var clenOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  var fixedLit = null;
  var fixedDist = null;
  var j;

  for (;;) {
    var final = bits(1);
    var type = bits(2);

    if (type === 0) {
      bitBuf = 0;
      bitCount = 0;
      if (pos + 4 > input.length) throw new Error('inflate: truncated stored block');
      var len = input[pos] | (input[pos + 1] << 8);
      pos += 4;
      if (pos + len > input.length) throw new Error('inflate: truncated stored data');
      grow(len);
      out.set(input.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
    } else {
      var litTree;
      var distTree;
      if (type === 1) {
        if (!fixedLit) {
          var litLengths = new Uint8Array(288);
          for (j = 0; j < 144; j++) litLengths[j] = 8;
          for (j = 144; j < 256; j++) litLengths[j] = 9;
          for (j = 256; j < 280; j++) litLengths[j] = 7;
          for (j = 280; j < 288; j++) litLengths[j] = 8;
          fixedLit = buildTree(litLengths);
          var distLengths = new Uint8Array(30);
          for (j = 0; j < 30; j++) distLengths[j] = 5;
          fixedDist = buildTree(distLengths);
        }
        litTree = fixedLit;
        distTree = fixedDist;
      } else if (type === 2) {
        var hlit = bits(5) + 257;
        var hdist = bits(5) + 1;
        var hclen = bits(4) + 4;
        var clenLengths = new Uint8Array(19);
        for (j = 0; j < hclen; j++) clenLengths[clenOrder[j]] = bits(3);
        var clenTree = buildTree(clenLengths);
        var lengths = new Uint8Array(hlit + hdist);
        var n = 0;
        while (n < lengths.length) {
          var sym = decodeSymbol(clenTree);
          if (sym < 16) { lengths[n++] = sym; continue; }
          var repeat;
          var value = 0;
          if (sym === 16) { value = lengths[n - 1]; repeat = 3 + bits(2); }
          else if (sym === 17) repeat = 3 + bits(3);
          else repeat = 11 + bits(7);
          while (repeat-- > 0 && n < lengths.length) lengths[n++] = value;
        }
        litTree = buildTree(lengths.subarray(0, hlit));
        distTree = buildTree(lengths.subarray(hlit));
      } else {
        throw new Error('inflate: reserved block type');
      }

      for (;;) {
        var symbol = decodeSymbol(litTree);
        if (symbol === 256) break;
        if (symbol < 256) {
          grow(1);
          out[outLen++] = symbol;
          continue;
        }
        var li = symbol - 257;
        if (li >= lengthBase.length) throw new Error('inflate: bad length code');
        var length = lengthBase[li] + bits(lengthExtra[li]);
        var dsym = decodeSymbol(distTree);
        if (dsym >= distBase.length) throw new Error('inflate: bad distance code');
        var distance = distBase[dsym] + bits(distExtra[dsym]);
        if (distance > outLen) throw new Error('inflate: distance beyond output');
        grow(length);
        var from = outLen - distance;
        for (var q = 0; q < length; q++) out[outLen + q] = out[from + q];
        outLen += length;
      }
    }
    if (final) break;
  }
  return out.subarray(0, outLen);
}

/**
 * UTF-8 decode, `TextDecoder` when the engine has it.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function ppUtf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  var s = '';
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); i += 1; }
    else if (b < 0xe0) { s += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
    else if (b < 0xf0) { s += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
    else {
      var cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      s += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return s;
}

/**
 * Put the media back.
 *
 * D6 keeps media out of the compressed payload — it is already in compressed
 * formats, and base64-ing a deflate stream that contains base64 pays the
 * expansion twice. So the model travels with `@m<n>` placeholders and the data
 * URIs travel beside it, one per line, and this walk reunites them.
 *
 * @param {any} value
 * @param {string[]} table
 * @returns {any}
 */
export function ppRehydrateMedia(value, table) {
  if (typeof value === 'string') {
    var m = /^@m(\d+)$/.exec(value);
    if (m) {
      var hit = table[Number(m[1])];
      return hit === undefined ? value : hit;
    }
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Object.prototype.toString.call(value) === '[object Array]') {
    for (var i = 0; i < value.length; i++) value[i] = ppRehydrateMedia(value[i], table);
    return value;
  }
  for (var key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) value[key] = ppRehydrateMedia(value[key], table);
  }
  return value;
}

/**
 * Inflate the model payload, preferring the platform decompressor (D5) and
 * falling back to the embedded one.
 *
 * @param {Uint8Array} bytes
 * @param {string} mode  'deflate' or 'raw'
 * @returns {Promise<Uint8Array>}
 */
export function ppDecodePayload(bytes, mode) {
  if (mode !== 'deflate') return Promise.resolve(bytes);
  var Platform = typeof DecompressionStream === 'function' ? DecompressionStream : null;
  if (!Platform) {
    try { return Promise.resolve(ppInflateRaw(bytes)); } catch (e) { return Promise.reject(e); }
  }
  try {
    var stream = new Platform('deflate-raw');
    var writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    var reader = stream.readable.getReader();
    var chunks = [];
    var total = 0;
    var pump = function () {
      return reader.read().then(function (step) {
        if (step.done) {
          var joined = new Uint8Array(total);
          var at = 0;
          for (var i = 0; i < chunks.length; i++) { joined.set(chunks[i], at); at += chunks[i].length; }
          return joined;
        }
        chunks.push(step.value);
        total += step.value.length;
        return pump();
      });
    };
    return pump().catch(function () { return ppInflateRaw(bytes); });
  } catch (e) {
    return Promise.resolve(ppInflateRaw(bytes));
  }
}

/**
 * Boot the artifact.
 *
 * By the time this runs the client is already looking at the opening beat: the
 * emitter wrote it into the document as static HTML (§12 cold-boot budget), and
 * `RuntimeHost` adopts that markup rather than repainting it. All this does is
 * reassemble the model and make the keyboard work.
 *
 * @param {object} config
 * @param {string} config.modelId    element id holding the base64 model payload
 * @param {string} config.mediaId    element id holding the media table
 * @param {string} config.mode       'deflate' or 'raw'
 * @param {Document} config.document
 * @param {Window} config.window
 * @returns {Promise<any>}
 */
export function ppBootArtifact(config) {
  var doc = config.document;
  var win = config.window;
  var runtimeApi = win.PitchProofRuntime;
  var modelNode = doc.getElementById(config.modelId);
  var mediaNode = doc.getElementById(config.mediaId);
  var payload = ppBase64ToBytes(modelNode ? modelNode.textContent : '');

  return ppDecodePayload(payload, config.mode).then(function (raw) {
    var proof = JSON.parse(ppUtf8Decode(raw));
    var table = [];
    if (mediaNode && mediaNode.textContent) {
      var text = mediaNode.textContent;
      var lines = text.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line) table.push(line);
      }
    }
    if (table.length) ppRehydrateMedia(proof, table);

    if (runtimeApi && typeof runtimeApi.registerAllLayouts === 'function') runtimeApi.registerAllLayouts();
    var booted = runtimeApi.boot({ proof: proof, document: doc, window: win });
    // The composition root (`src/artifact.js`) already registers the jump, map
    // and contents overlays and installs the input bridge. This guard exists
    // for a bundle that does not, and it checks first: registering a second
    // time would install a second controller whose render function replaces the
    // first's, while the input bridge still holds the first — the overlay would
    // then be drawn by one object and driven by another. It also deliberately
    // announces no change, since no overlay is open at boot and a repaint would
    // only discard the markup the emitter pre-rendered.
    var overlays = booted.runtime && booted.runtime.overlays;
    var alreadyWired = !!(overlays && overlays.registry && overlays.registry.has('jump'));
    if (!alreadyWired && runtimeApi && typeof runtimeApi.registerBranchOverlays === 'function') {
      runtimeApi.registerBranchOverlays(booted.runtime);
    }
    win.__PITCHPROOF__ = {
      runtime: booted.runtime,
      host: booted.host,
      version: runtimeApi.RUNTIME_VERSION,
      ready: true,
    };
    if (doc.documentElement && doc.documentElement.setAttribute) {
      doc.documentElement.setAttribute('data-pp-ready', 'true');
    }
    return booted;
  }).catch(function (error) {
    if (doc.documentElement && doc.documentElement.setAttribute) {
      doc.documentElement.setAttribute('data-pp-boot-error', String(error && error.message ? error.message : error));
    }
    win.__PITCHPROOF__ = { ready: false, error: String(error && error.message ? error.message : error) };
    throw error;
  });
}

/**
 * The decode path for an uncompressed payload. Emitted instead of
 * `ppDecodePayload` when the emitter measured the raw variant as smaller, so an
 * artifact that does not compress does not carry an inflater it never calls.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export function ppDecodePayloadRaw(bytes) {
  return Promise.resolve(bytes);
}

/**
 * The artifact's boot source, in dependency order.
 *
 * The two variants differ by exactly one thing: the compressed variant carries
 * `ppInflateRaw` as the fallback for engines without `DecompressionStream`, and
 * the raw variant does not carry it at all. `emit/model.js` counts the
 * difference when it decides which variant is actually smaller, so the
 * comparison §13 asks for is made on the bytes the file really pays.
 *
 * @param {'deflate'|'raw'} mode
 * @returns {string}
 */
export function artifactRuntimeSource(mode) {
  if (mode === 'raw') {
    return [
      ppBase64ToBytes.toString(),
      ppUtf8Decode.toString(),
      ppRehydrateMedia.toString(),
      ppDecodePayloadRaw.toString(),
      'var ppDecodePayload = ppDecodePayloadRaw;',
      ppBootArtifact.toString(),
    ].join('\n\n');
  }
  return [
    ppBase64ToBytes.toString(),
    ppInflateRaw.toString(),
    ppUtf8Decode.toString(),
    ppRehydrateMedia.toString(),
    ppDecodePayload.toString(),
    ppBootArtifact.toString(),
  ].join('\n\n');
}
