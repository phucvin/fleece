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

console.log("All tests passed!");
