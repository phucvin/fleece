const { FleeceEncoder, FleeceDecoder } = require('./fleece');

function benchmark() {
    console.log("Creating large dataset...");
    const size = 10000;
    const data = {
        items: []
    };
    for (let i = 0; i < size; i++) {
        data.items.push({
            id: i,
            name: `Item ${i}`,
            value: Math.random(),
            tags: ["tag1", "tag2", "tag3"],
            nested: {
                a: i,
                b: i * 2
            }
        });
    }

    const jsonStr = JSON.stringify(data);
    const encoder = new FleeceEncoder();
    const fleeceBuf = encoder.encode(data);

    console.log(`JSON size: ${jsonStr.length} bytes`);
    console.log(`Fleece size: ${fleeceBuf.length} bytes`);

    const iterations = 100;

    // Benchmark 1: Full Decode
    console.log("\nBenchmark: Full Decode");

    let start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        JSON.parse(jsonStr);
    }
    let end = process.hrtime.bigint();
    const jsonTime = Number(end - start) / 1e6; // ms
    console.log(`JSON.parse: ${jsonTime.toFixed(2)} ms (${(jsonTime/iterations).toFixed(3)} ms/op)`);

    start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        const decoder = new FleeceDecoder(fleeceBuf);
        decoder.decode();
    }
    end = process.hrtime.bigint();
    const fleeceTime = Number(end - start) / 1e6; // ms
    console.log(`Fleece decode: ${fleeceTime.toFixed(2)} ms (${(fleeceTime/iterations).toFixed(3)} ms/op)`);


    // Benchmark 2: Lazy Read of one item deep in the structure
    console.log("\nBenchmark: Lazy Read (Accessing items[5000].nested.b)");

    start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        const obj = JSON.parse(jsonStr);
        const val = obj.items[5000].nested.b;
    }
    end = process.hrtime.bigint();
    const jsonLazyTime = Number(end - start) / 1e6; // ms
    console.log(`JSON parse + access: ${jsonLazyTime.toFixed(2)} ms (${(jsonLazyTime/iterations).toFixed(3)} ms/op)`);

    start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        const decoder = new FleeceDecoder(fleeceBuf);
        const root = decoder.getRoot();
        const val = root.asDict().get("items").asArray().get(5000).asDict().get("nested").asDict().get("b").asNumber();
    }
    end = process.hrtime.bigint();
    const fleeceLazyTime = Number(end - start) / 1e6; // ms
    console.log(`Fleece lazy access: ${fleeceLazyTime.toFixed(2)} ms (${(fleeceLazyTime/iterations).toFixed(3)} ms/op)`);
}

benchmark();
