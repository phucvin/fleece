# Fleece JavaScript Implementation

This directory contains a JavaScript implementation of [Fleece](https://github.com/couchbaselabs/fleece), a binary encoding for semi-structured data designed to be efficient to read without parsing.

## Features

*   **Encoding**: Encodes JavaScript objects (null, boolean, number, string, array, object) into Fleece binary format.
*   **Decoding**: Decodes Fleece binary data back into JavaScript objects.
*   **Lazy Reading**: Supports accessing data directly from the binary buffer without parsing the entire structure. This allows for extremely fast random access.
*   **'Wide' Collections**: Automatically handles large collections by switching to 4-byte slots when offsets exceed the 16-bit limit.
*   **Zero-Copy (conceptually)**: When using lazy reading, strings and binary data are extracted only when accessed.
*   **Append-Only Mutation**: Supports efficient delta updates to existing Fleece documents.

## Usage

### Installation

Currently, this implementation is provided as source files. You can include `fleece.js` in your project.

### Encoding

```javascript
const { FleeceEncoder } = require('./fleece');

const data = {
    name: "Fleece",
    version: 1,
    tags: ["fast", "binary"],
    meta: { active: true }
};

const encoder = new FleeceEncoder();
const encodedData = encoder.encode(data); // Returns Uint8Array
```

### Decoding (Full)

To convert the entire Fleece data back into a JavaScript object:

```javascript
const { FleeceDecoder } = require('./fleece');

const decoder = new FleeceDecoder(encodedData);
const decodedObject = decoder.decode();
console.log(decodedObject);
```

### Lazy Reading

Lazy reading allows you to navigate the data structure without parsing everything. This is where Fleece shines in terms of performance.

```javascript
const { FleeceDecoder } = require('./fleece');

const decoder = new FleeceDecoder(encodedData);
const root = decoder.getRoot(); // Returns a FleeceValue

// Check type
if (root.getType() === 'dict') {
    const dict = root.asDict();

    // Access a key directly
    const nameValue = dict.get("name");
    console.log(nameValue.asString()); // "Fleece"

    // Access nested data
    const activeValue = dict.get("meta").asDict().get("active");
    console.log(activeValue.asBoolean()); // true
}
```

### Mutation & Delta Updates

Fleece data is immutable by design. However, this implementation supports efficient "append-only" updates via mutable wrappers and delta encoding.

1.  **Create a Mutable View**: Call `.asMutable()` on any `FleeceValue`, `FleeceDict`, or `FleeceArray`.
2.  **Modify Data**: Use standard methods like `.set()`, `.getMutable()`, `.push()`, etc.
3.  **Encode Delta**: Use `encoder.setBase(originalBuffer)` before encoding. The encoder will output only the changes (delta), reusing pointers to unchanged data in the original buffer.

```javascript
const { FleeceEncoder, FleeceDecoder } = require('./fleece');

// 1. Load original immutable data
const baseBuffer = ...; // Uint8Array
const root = new FleeceDecoder(baseBuffer).getRoot();

// 2. Create mutable wrapper
const mutableRoot = root.asMutable();

// 3. Modify
mutableRoot.set("version", 2);
mutableRoot.getMutable("tags").push("updated");

// 4. Encode Delta
const deltaEncoder = new FleeceEncoder();
deltaEncoder.setBase(baseBuffer); // Important!
const deltaBuffer = deltaEncoder.encode(mutableRoot);

// 5. Append (e.g., to a file)
const newTotalBuffer = new Uint8Array(baseBuffer.length + deltaBuffer.length);
newTotalBuffer.set(baseBuffer);
newTotalBuffer.set(deltaBuffer, baseBuffer.length);
```

## Testing

To run the test suite:

```bash
node js/test.js
```

## Benchmarking

To run the benchmarks:

```bash
node js/benchmark.js
```

### Benchmark Results

The following results compare `JSON.parse` vs Fleece.

*   **Full Decode**: Parsing the entire structure into a JS object.
*   **Lazy Read**: Accessing a single deeply nested item (`items[5000].nested.b`).

| Operation | JSON (ms/op) | Fleece (ms/op) | Note |
| :--- | :--- | :--- | :--- |
| **Full Decode** | ~15 ms | ~105 ms | `JSON.parse` is native and highly optimized. Fleece full decode is slower in JS. |
| **Lazy Read** | ~14 ms | **~0.003 ms** | **Fleece is orders of magnitude faster** because it doesn't parse the file. |

*Benchmarks run on a large dataset (approx 1MB JSON).*

As seen above, Fleece is ideal for scenarios where you need to access specific parts of a large document without paying the cost of parsing the entire thing.
