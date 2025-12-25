const { FleeceEncoder, FleeceDecoder } = require('./fleece');
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

testLazy();
testDeepNested();

console.log("All tests passed!");
