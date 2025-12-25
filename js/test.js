const { FleeceEncoder, FleeceDecoder, FleeceValue, MutableDict, MutableArray } = require('./fleece');
const assert = require('assert');

function test(name, value) {
    try {
        const encoder = new FleeceEncoder();
        const encoded = encoder.encode(value);

        const decoder = new FleeceDecoder(encoded);
        const decoded = decoder.decode();

        // Deep equal check
        assert.deepStrictEqual(decoded, value);
        console.log(`PASS: ${name}`);
    } catch (e) {
        console.error(`FAIL: ${name}`, e);
        process.exit(1);
    }
}

test("Null", null);
test("True", true);
test("False", false);
test("Small Integer", 123);
test("Negative Small Integer", -123);
test("Zero", 0);
test("Large Integer", 100000);
test("Large Negative Integer", -100000);
test("Float", 123.456);
test("String", "Hello World");
test("Empty String", "");
test("Array of numbers", [1, 2, 3]);
test("Array of strings", ["foo", "bar"]);
test("Nested Array", [1, [2, 3], 4]);
test("Dictionary", { "a": 1, "b": 2 });
test("Nested Dictionary", { "foo": { "bar": 123 } });
test("Complex Structure", {
    "name": "Fleece",
    "compact": true,
    "version": 1,
    "tags": ["binary", "json", "fast"],
    "meta": {
        "author": "Jens",
        "score": 99.9
    }
});

function testLazy() {
    console.log("Testing Lazy Access...");

    const data = {
        "a": 1,
        "b": [10, 20, 30],
        "c": { "x": "hello", "y": "world" }
    };

    const encoder = new FleeceEncoder();
    const encoded = encoder.encode(data);
    const decoder = new FleeceDecoder(encoded);
    const root = decoder.getRoot();

    // Check Root Type
    assert.strictEqual(root.getType(), 'dict');
    const dict = root.asDict();

    // Check Keys
    const keys = Array.from(dict.keys());
    assert.deepStrictEqual(keys, ["a", "b", "c"]);

    // Check "a"
    const valA = dict.get("a");
    assert.strictEqual(valA.getType(), 'number');
    assert.strictEqual(valA.asNumber(), 1);

    // Check "b"
    const valB = dict.get("b");
    assert.strictEqual(valB.getType(), 'array');
    const arrB = valB.asArray();
    assert.strictEqual(arrB.length, 3);
    assert.strictEqual(arrB.get(0).asNumber(), 10);
    assert.strictEqual(arrB.get(1).asNumber(), 20);
    assert.strictEqual(arrB.get(2).asNumber(), 30);
    assert.strictEqual(arrB.get(3), undefined); // Out of bounds

    // Check "c"
    const valC = dict.get("c");
    assert.strictEqual(valC.getType(), 'dict');
    const dictC = valC.asDict();
    assert.strictEqual(dictC.get("x").asString(), "hello");
    assert.strictEqual(dictC.get("y").asString(), "world");
    assert.strictEqual(dictC.get("z"), undefined); // Missing key

    console.log("PASS: Lazy Access");
}

function testDeepNested() {
    console.log("Testing Deep Nested Lazy Access...");
    const data = { "level1": { "level2": { "level3": [1, 2, 3] } } };

    const encoder = new FleeceEncoder();
    const encoded = encoder.encode(data);
    const decoder = new FleeceDecoder(encoded);

    const val = decoder.getRoot()
        .asDict().get("level1")
        .asDict().get("level2")
        .asDict().get("level3")
        .asArray().get(1)
        .asNumber();

    assert.strictEqual(val, 2);
    console.log("PASS: Deep Nested Lazy Access");
}

function testMutation() {
    console.log("Testing Mutation...");

    // 1. Create Base Document
    const baseData = {
        "title": "Fleece Mutation",
        "count": 100,
        "tags": ["alpha", "beta"],
        "meta": { "author": "Jules", "version": 1 }
    };

    const baseEncoder = new FleeceEncoder();
    const baseBuffer = baseEncoder.encode(baseData);

    // Verify Base
    const baseDecoder = new FleeceDecoder(baseBuffer);
    const root = baseDecoder.getRoot();
    assert.strictEqual(root.asDict().get("title").asString(), "Fleece Mutation");

    // 2. Create Mutable Wrapper
    const mutableRoot = root.asMutable();
    assert.ok(mutableRoot instanceof MutableDict);

    // 3. Mutate
    mutableRoot.set("count", 101); // Modify existing
    mutableRoot.set("newField", "Hello"); // Add new
    mutableRoot.remove("title"); // Remove existing

    const tags = mutableRoot.getMutable("tags");
    assert.ok(tags instanceof MutableArray);
    tags.push("gamma");

    const meta = mutableRoot.getMutable("meta");
    assert.ok(meta instanceof MutableDict);
    meta.set("version", 2);

    // 4. Encode Delta
    const deltaEncoder = new FleeceEncoder();
    deltaEncoder.setBase(baseBuffer);
    const deltaBuffer = deltaEncoder.encode(mutableRoot);

    console.log(`Base Size: ${baseBuffer.length}, Delta Size: ${deltaBuffer.length}`);

    // 5. Concatenate and Verify
    const finalBuffer = new Uint8Array(baseBuffer.length + deltaBuffer.length);
    finalBuffer.set(baseBuffer, 0);
    finalBuffer.set(deltaBuffer, baseBuffer.length);

    const finalDecoder = new FleeceDecoder(finalBuffer);
    const finalRoot = finalDecoder.getRoot().asDict();

    // Check modifications
    assert.strictEqual(finalRoot.get("count").asNumber(), 101);
    assert.strictEqual(finalRoot.get("newField").asString(), "Hello");
    assert.strictEqual(finalRoot.get("title"), undefined);

    // Check nested array
    const finalTags = finalRoot.get("tags").asArray();
    assert.strictEqual(finalTags.length, 3);
    assert.strictEqual(finalTags.get(0).asString(), "alpha");
    assert.strictEqual(finalTags.get(2).asString(), "gamma");

    // Check nested dict
    const finalMeta = finalRoot.get("meta").asDict();
    assert.strictEqual(finalMeta.get("version").asNumber(), 2);
    assert.strictEqual(finalMeta.get("author").asString(), "Jules");

    console.log("PASS: Mutation Logic");
}

function testReuse() {
    console.log("Testing Value Reuse...");

    // Create a large string to ensure it's worth reusing (though all strings are reused if pointing to base)
    const largeString = "A".repeat(1000);
    const baseData = { "kept": largeString, "changed": "old" };

    const baseEncoder = new FleeceEncoder();
    const baseBuffer = baseEncoder.encode(baseData);

    const root = new FleeceDecoder(baseBuffer).getRoot();
    const mutable = root.asMutable();
    mutable.set("changed", "new");

    const deltaEncoder = new FleeceEncoder();
    deltaEncoder.setBase(baseBuffer);
    const deltaBuffer = deltaEncoder.encode(mutable);

    // Delta should be small because it reuses 'kept' string pointer
    // 'kept' key + pointer (2 bytes) + 'changed' key + 'new' string + headers.
    // 'kept' string (1000 bytes) should NOT be in delta.

    console.log(`Delta Size: ${deltaBuffer.length}`);
    assert.ok(deltaBuffer.length < 100, "Delta should be small (reusing large string)");

    const finalBuffer = new Uint8Array(baseBuffer.length + deltaBuffer.length);
    finalBuffer.set(baseBuffer, 0);
    finalBuffer.set(deltaBuffer, baseBuffer.length);

    const finalRoot = new FleeceDecoder(finalBuffer).getRoot().asDict();
    assert.strictEqual(finalRoot.get("kept").asString(), largeString);
    assert.strictEqual(finalRoot.get("changed").asString(), "new");

    console.log("PASS: Value Reuse");
}

function testDeepReuse() {
    console.log("Testing Deep Reuse...");

    const baseData = { "a": { "x": 1, "y": 2 }, "b": [1, 2, 3] };
    const baseBuffer = new FleeceEncoder().encode(baseData);

    const root = new FleeceDecoder(baseBuffer).getRoot();
    const mutable = root.asMutable();

    // We only modify top level "b". "a" is untouched.
    mutable.set("b", [4, 5]);

    const deltaEncoder = new FleeceEncoder();
    deltaEncoder.setBase(baseBuffer);
    const deltaBuffer = deltaEncoder.encode(mutable);

    // "a" should be encoded as a pointer to the original "a" dict in baseBuffer.
    // So delta should not contain "x":1, "y":2.

    const finalBuffer = new Uint8Array(baseBuffer.length + deltaBuffer.length);
    finalBuffer.set(baseBuffer);
    finalBuffer.set(deltaBuffer, baseBuffer.length);

    const finalRoot = new FleeceDecoder(finalBuffer).getRoot().asDict();
    const a = finalRoot.get("a").asDict();
    assert.strictEqual(a.get("x").asNumber(), 1);

    console.log("PASS: Deep Reuse");
}

testLazy();
testDeepNested();
testMutation();
testReuse();
testDeepReuse();

console.log("All tests passed!");
