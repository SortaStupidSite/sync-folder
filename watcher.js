const chokidar = require("chokidar");
const fs = require("fs");
const fse = require("fs-extra");
const crypto = require("crypto");
const path = require("path");

// ============================
// LOAD CONFIG
// ============================

const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "config.json"), "utf-8")
);

const WATCH_FOLDER = config.watchFolder;
const DEST_ROOT = config.destinationRoot;
const LOG_FILE = config.logFile;
const EXTENSIONS = config.fileExtensions || [".mp4"];
const OPT = config.options || {};

// ============================
// LOGGING
// ============================

function log(msg) {
    const line = `[${new Date().toISOString().slice(0, 19).replace("T", " ")}] ${msg}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + "\n");
}

// ============================
// HELPERS
// ============================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// wait for file to stabilize locally
async function waitForStable(filePath) {
    let lastSize = -1;

    for (let i = 0; i < 30; i++) {
        try {
            const s = fs.statSync(filePath);
            if (s.size === lastSize && s.size > 0) return;
            lastSize = s.size;
        } catch {}
        await sleep(1000);
    }

    throw new Error("File did not stabilize");
}

// wait for local unlock
async function waitForUnlock(filePath) {
    for (let i = 0; i < 60; i++) {
        try {
            const fd = fs.openSync(filePath, "r");
            fs.closeSync(fd);
            return;
        } catch {
            await sleep(500);
        }
    }
    throw new Error("File stayed locked");
}

// STREAMING MD5 (handles 5GB+ files)
function md5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("md5");
        const stream = fs.createReadStream(filePath);

        stream.on("data", d => hash.update(d));
        stream.on("error", reject);
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

// SMB readiness check (fixes EBUSY)
async function waitForSMBReady(filePath) {

    let lastSize = -1;

    for (let i = 0; i < 60; i++) {

        try {
            const s = fs.statSync(filePath);

            if (s.size > 0 && s.size === lastSize) {
                const fd = fs.openSync(filePath, "r");
                fs.closeSync(fd);
                return;
            }

            lastSize = s.size;

        } catch {}

        await sleep(1000);
    }

    throw new Error("SMB file not ready");
}

// show name parser
function extractShow(filename) {
    return filename
        .replace(/\.[^/.]+$/, "")
        .replace(/([_\-\s]*)(\d+x\d+(-\d+)?|S\d+E\d+|\d+-\d+|\d+)$/i, "")
        .replace(/_/g, " ")
        .trim();
}

// safe copy retry
async function safeCopy(src, dest) {
    for (let i = 0; i < 5; i++) {
        try {
            await fse.copy(src, dest, { overwrite: true });
            return;
        } catch {
            await sleep(2000);
        }
    }
    throw new Error("Copy failed");
}

// safe hash with retry
async function safeHash(filePath) {
    for (let i = 0; i < 10; i++) {
        try {
            await waitForSMBReady(filePath);
            return await md5(filePath);
        } catch {
            await sleep(1000);
        }
    }
    throw new Error("Hash failed");
}

// ============================
// PROCESSOR
// ============================

const processing = new Set();

async function processFile(filePath) {

    if (processing.has(filePath)) return;
    processing.add(filePath);

    try {
        log(`Detected: ${filePath}`);

        if (!fs.existsSync(filePath)) {
            log("File missing");
            return;
        }

        await waitForStable(filePath);
        await waitForUnlock(filePath);

        const fileName = path.basename(filePath);
        const show = extractShow(fileName);

        log(`Show: ${show}`);

        const destDir = path.join(DEST_ROOT, show);
        await fse.ensureDir(destDir);

        const destFile = path.join(destDir, fileName);

        log(`Copy → ${destFile}`);
        await safeCopy(filePath, destFile);

        // SMB settle time
        await sleep(1000);

        if (OPT.verifyChecksum) {

            log("Checking SMB readiness...");
            await waitForSMBReady(destFile);

            log("MD5 source...");
            const src = await md5(filePath);

            log("MD5 destination...");
            const dst = await safeHash(destFile);

            log(`SRC: ${src}`);
            log(`DST: ${dst}`);

            if (src === dst) {
                log("MATCH");

                if (OPT.deleteAfterVerify) {
                    log("Deleting local file");
                    fs.unlinkSync(filePath);
                }

            } else {
                log("MISMATCH - keeping file");
            }

        }

        log("Done");

    } catch (err) {
        log(`ERROR: ${err.message}`);
    } finally {
        processing.delete(filePath);
    }
}

// ============================
// WATCHER
// ============================

log("Starting watcher...");
log(`Watch: ${WATCH_FOLDER}`);
log(`Dest: ${DEST_ROOT}`);

const watcher = chokidar.watch(WATCH_FOLDER, {
    persistent: true,
    ignoreInitial: true,

    usePolling: OPT.usePolling ?? true,
    interval: 1000,

    awaitWriteFinish: {
        stabilityThreshold: 3000,
        pollInterval: 1000
    }
});

watcher.on("add", (filePath) => {
    const ext = path.extname(filePath).toLowerCase();

    if (!EXTENSIONS.includes(ext)) return;

    processFile(filePath);
});