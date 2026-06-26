const chokidar = require("chokidar");
const fs = require("fs");
const fSPromises = require('fs/promises');
const fse = require("fs-extra");
const crypto = require("crypto");
const path = require("path");
const ms = require('ms');




// ============================
// CONFIG
// ============================

const CONFIG_FILE = path.join(__dirname, "config.json");
const config = JSON.parse(
    fs.readFileSync(CONFIG_FILE, "utf-8")
);

const WATCH_FOLDER = config.watchFolder;
const SERVER_ROOT = config.serverRoot;
const LOG_FILE = config.logFile;
const ERROR_FILE = config.errorFile;
const MIGRATION_TIME = config.migrationTime
const EXTENSIONS = config.fileExtensions || [".mp4"];
const OPT = config.options || {};
const ROUTES = config.folders || [];


// ============================
// LOGGING
// ============================

function log(msg) {
    const currentDate = new Date();
    const line = `[${currentDate.toLocaleDateString()+" "+currentDate.toLocaleTimeString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + "\n");
}

function error(msg) {
    const currentDate = new Date();
    const line = `[${currentDate.toLocaleDateString()+" "+currentDate.toLocaleTimeString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(ERROR_FILE, line + "\n");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================
// HELPERS
// ============================

function getRoute(filePath) {
    const lower = filePath.toLowerCase();
    return ROUTES.find(r => lower.includes(r.name.toLowerCase()));
}

// ============================
// HELPERS
// ============================

async function waitForStable(filePath) {
    let last = -1;

    for (let i = 0; i < 30; i++) {
        try {
            const s = fs.statSync(filePath);
            if (s.size === last && s.size > 0) return;
            last = s.size;
        } catch {}
        await sleep(1000);
    }

    throw new Error("File not stable");
}

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

    throw new Error("Locked for to long");
}

function md5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("md5");
        const stream = fs.createReadStream(filePath);

        stream.on("data", d => hash.update(d));
        stream.on("error", reject);
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

async function waitForSMBReady(filePath) {

    let last = -1;

    for (let i = 0; i < 60; i++) {
        try {
            const s = fs.statSync(filePath);

            if (s.size > 0 && s.size === last) {
                const fd = fs.openSync(filePath, "r");
                fs.closeSync(fd);
                return;
            }

            last = s.size;
        } catch {}

        await sleep(1000);
    }

    throw new Error("SMB not ready");
}

function extractShow(filename) {
    return filename
        .replace(/\.[^/.]+$/, "")
        .replace(/([_\-\s]*)(\d+x\d+(-\d+)?|S\d+E\d+|\d+-\d+|\d+)$/i, "")
        .replace(/_/g, " ")
        .trim();
}

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

async function sendLog(logFile){
    const logFileName = path.basename(logFile);
    const destLogFile = path.join(SERVER_ROOT, logFileName);

    if (fs.existsSync(logFile)){
        await safeCopy(logFile, destLogFile);
    }
}

async function getFilesModifiedWithin(dir, timeString) {
    const duration = ms(timeString);

    if (!duration) {
        throw new Error(`Invalid time string: "${timeString}"`);
    }

    const cutoff = Date.now() - duration;
    const matches = [];

    async function walk(currentDir) {
        const entries = await fSPromises.readdir(currentDir, {
            withFileTypes: true
        });

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }

            const stats = await fSPromises.stat(fullPath);

            // Windows "Modified Date" = mtime
            if (stats.mtime.getTime() > cutoff) {
                matches.push({
                    file: fullPath,
                    modified: stats.mtime
                });
            }
        }
    }

    await walk(dir);

    return matches;
}

// ============================
// CORE PROCESSOR
// ============================

const processing = new Set();

async function processFile(filePath, { skipIfExists = true } = {}) {

    if (processing.has(filePath)) return;
    processing.add(filePath);

    try {

        log(`Detected: ${filePath}`);
        if (!fs.existsSync(filePath)) {
            error(`Missing: ${filePath}`);
            return;
        }

        await waitForStable(filePath);
        await waitForUnlock(filePath);

        const fileName = path.basename(filePath);
        const route = getRoute(filePath);

        if (!route) {
            error(`No route: ${filePath}`);
            return;
        }

        log(`Route: ${route.name}`);

        let serverDir;
        let simLinkDir;
        simLinkDir = path.join(WATCH_FOLDER, route.simlinkName);
        if (route.extractShow) {
            const show = extractShow(fileName);
            log(`Show extracted: ${show}`);
            serverDir = path.join(SERVER_ROOT, route.subfolder, show);
        } else {
            serverDir = path.join(SERVER_ROOT, route.subfolder);
        }

        await fse.ensureDir(serverDir);
        await fse.ensureDir(simLinkDir);

        const serverFile = path.join(serverDir, fileName);
        const simLinkFile = path.join(simLinkDir, fileName);

        if (!skipIfExists || !fs.existsSync(serverFile)) {
            log(`Processing: ${filePath} → ${serverFile}`);
            await safeCopy(filePath, serverFile);
            await sleep(1000);

            if (OPT.verifyChecksum) {
                log("Checking SMB readiness...");
                await waitForSMBReady(serverFile);

                log("MD5 source...");
                const srcHash = await md5(filePath);

                log("MD5 destination...");
                const dstHash = await md5(serverFile);
                
                log(`SRC: ${srcHash}`);
                log(`DST: ${dstHash}`);
                if (srcHash === dstHash) {
                    log("MD5 MATCH");

                    if (OPT.deleteAfterVerify) {
                        log("[DEBUG] WOULD Delete source now");
                        ////////fs.unlinkSync(filePath);
                    }

                } else {
                    error("MD5 MISMATCH → keeping file");
                }
            }

        }else{
            log(`SKIP (exists): ${serverFile}`);
        }

        if (!skipIfExists || !fs.existsSync(simLinkFile)) {
            log(`Processing: ${filePath} → ${simLinkFile}`);
            await safeCopy(filePath, simLinkFile);

        }else{
            log(`SKIP (exists): ${simLinkFile}`);
        }


        log("Done");

    } catch (err) {
        error(`ERROR: ${err.message}`);
    } finally {
        processing.delete(filePath);
    }
}

// ============================
// STARTUP SYNC (NEW FEATURE)
// ============================

async function initialSync() {

    log("Starting initial sync...");
    for (const route of ROUTES ){
        log(`Syncing ${route.name}`)
        const syncFolder = path.join(WATCH_FOLDER, route.name);
        const files = fs.readdirSync(syncFolder);

        for (const f of files) {

            const full = path.join(syncFolder, f);

            try {
                const stat = fs.statSync(full);

                if (!stat.isFile()) continue;
                if (!EXTENSIONS.includes(path.extname(full).toLowerCase())) continue;

                await processFile(full, { skipIfExists: true });

            } catch (e) {
                error(`SYNC ERROR: ${e.message}`);
            }
        }
        let filesToMove=getFilesModifiedWithin(syncFolder,MIGRATION_TIME)
        for (const f of filesToMove) {
            console.log(f)
        }
    }
    
    log("Initial sync complete");

    await sendLog(CONFIG_FILE)
    await sendLog(LOG_FILE)
    await sendLog(ERROR_FILE)

    
    
}



// ============================
// WATCHER
// ============================
/*
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

    processFile(filePath, { skipIfExists: true });
});
*/
// ============================
// BOOT STRAP
// ============================

initialSync().catch(err => log(`INIT ERROR: ${err.message}`));