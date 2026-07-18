const fs = require("fs-extra");
const path = require("path");
const os = require("os");
const { execa } = require("execa");

const INPUT = "./mp4/merge/";
const OUTPUT = "./mp4/output";

(async () => {
    await fs.ensureDir(OUTPUT);

    const files = await fs.readdir(INPUT);

    // Matches:
    // Movie Name 1.mp4
    // Movie Name 23.mp4
    const regex = /^(.*)\s+(\d+)\.mp4$/i;

    const groups = new Map();

    for (const file of files) {
        const match = file.match(regex);
        if (!match)
            continue;

        const base = match[1].trim();
        const number = Number(match[2]);

        if (!groups.has(base))
            groups.set(base, []);

        groups.get(base).push({
            file,
            number
        });
    }

    for (const [base, parts] of groups) {

        if (parts.length < 2) {
            console.log(`Skipping "${base}" (only one part)`);
            continue;
        }

        parts.sort((a, b) => a.number - b.number);

        console.log(`\nMerging ${base}`);

        const listFile = path.join(os.tmpdir(), `concat-${Date.now()}.txt`);

        const contents = parts
            .map(p => {
                const full = path.resolve(INPUT, p.file).replace(/'/g, "'\\''");
                return `file '${full}'`;
            })
            .join("\n");

        await fs.writeFile(listFile, contents);

        const outputFile = path.join(
            OUTPUT,
            `${base}.mp4`
        );

        try {

            await execa("ffmpeg", [
                "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", listFile,
                "-c", "copy",
                outputFile
            ], {
                stdout: "inherit",
                stderr: "inherit"
            });

            console.log(`✔ Saved ${outputFile}`);

        } finally {
            await fs.remove(listFile);
        }
    }
})();