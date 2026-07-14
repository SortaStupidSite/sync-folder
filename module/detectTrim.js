const { execa } = require("execa");
const VAD = require("node-vad");

const SAMPLE_RATE = 16000;
const FRAME_MS = 30;
const FRAME_SIZE = SAMPLE_RATE * 2 * FRAME_MS / 1000; // 960 bytes

async function detectTrim(inputFile, {
    audioTrack = 0,
    padStartMs = 300,
    padEndMs = 500,
    mode = VAD.Mode.AGGRESSIVE,
    minSpeechMs = 150,
    minSilenceMs = 750
} = {}) {

    const vad = new VAD(mode);
    const ffmpeg = execa("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",

        "-i", inputFile,
        "-map", `0:a:${audioTrack}`,

        "-ac", "1",
        "-ar", SAMPLE_RATE.toString(),

        "-f", "s16le",
        "-"
    ], {
        buffer: null
    });
    

    let buffer = Buffer.alloc(0);

    let currentTime = 0;

    let firstSpeech = null;
    let lastSpeech = null;

    let speechRun = 0;
    let silenceRun = 0;

    for await (const chunk of ffmpeg.stdout) {

        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= FRAME_SIZE) {

            const frame = buffer.subarray(0, FRAME_SIZE);
            buffer = buffer.subarray(FRAME_SIZE);

            const event = await vad.processAudio(frame, SAMPLE_RATE);

            const isSpeech =
                event === VAD.Event.VOICE ||
                event === VAD.Event.NOISE;

            if (isSpeech) {

                speechRun += FRAME_MS;
                silenceRun = 0;

                if (
                    firstSpeech === null &&
                    speechRun >= minSpeechMs
                ) {
                    firstSpeech = currentTime - (speechRun - FRAME_MS);
                }

                lastSpeech = currentTime;

            } else {

                silenceRun += FRAME_MS;
                speechRun = 0;
            }

            currentTime += FRAME_MS;
        }
    }

    if (firstSpeech === null)
        throw new Error("No speech detected.");

    return {

        start: Math.max(0, firstSpeech - padStartMs),

        end: lastSpeech + padEndMs
    };
}

module.exports = detectTrim;