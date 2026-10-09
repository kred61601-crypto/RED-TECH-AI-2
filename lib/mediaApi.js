
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";
const MAX_MEDIA_BYTES = 48 * 1024 * 1024;
const TIMEOUT = 60000;

const http = axios.create({
    timeout: TIMEOUT,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
    }
});

function validUrl(value) {
    try {
        const parsed = new URL(value);
        return ["http:", "https:"].includes(parsed.protocol);
    } catch {
        return false;
    }
}

function isTikTokUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return (
            host === "tiktok.com" ||
            host.endsWith(".tiktok.com")
        );
    } catch {
        return false;
    }
}

async function downloadBuffer(url) {
    if (!validUrl(url)) {
        throw new Error("Invalid media URL");
    }

    const response = await http.get(url, {
        responseType: "arraybuffer",
        maxContentLength: MAX_MEDIA_BYTES,
        maxBodyLength: MAX_MEDIA_BYTES,
        headers: {
            Accept: "video/mp4,video/*,application/octet-stream,*/*"
        }
    });

    const buffer = Buffer.from(response.data);
    const contentType = String(
        response.headers["content-type"] || ""
    ).toLowerCase();

    if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) {
        throw new Error("Media is empty or too large");
    }

    if (
        contentType.includes("text/html") ||
        contentType.includes("application/json")
    ) {
        throw new Error("The service returned a webpage instead of a video");
    }

    return buffer;
}

async function ytDlpSocialDownload(url) {
    if (!validUrl(url)) {
        throw new Error("Invalid URL");
    }

    const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "king-red-ai-")
    );

    const outputTemplate = path.join(tempDir, "video.%(ext)s");

    try {
        await execFileAsync(
            YTDLP_BIN,
            [
                "--no-playlist",
                "--no-warnings",
                "--max-filesize", `${MAX_MEDIA_BYTES}`,
                "-f", "best[ext=mp4]/best",
                "--merge-output-format", "mp4",
                "-o", outputTemplate,
                url
            ],
            { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
        );

        const files = await fs.promises.readdir(tempDir);
        const mediaFile = files.find(
            file => /\.(mp4|mkv|webm|mov)$/i.test(file)
        );

        if (!mediaFile) {
            throw new Error("yt-dlp did not produce a video file");
        }

        const filePath = path.join(tempDir, mediaFile);
        const stat = await fs.promises.stat(filePath);

        if (!stat.size || stat.size > MAX_MEDIA_BYTES) {
            throw new Error("Downloaded video is empty or too large");
        }

        return {
            buffer: await fs.promises.readFile(filePath),
            author: "Unknown"
        };
    } finally {
        await fs.promises.rm(tempDir, {
            recursive: true,
            force: true
        }).catch(() => {});
    }
}

async function tiktokDownload(url) {
    if (!validUrl(url) || !isTikTokUrl(url)) {
        throw new Error("Please provide a valid TikTok URL");
    }

    const services = [
        async () => {
            const response = await http.get(
                "https://www.tikwm.com/api/",
                {
                    params: { url },
                    timeout: TIMEOUT
                }
            );

            const data = response.data?.data;
            const videoUrl =
                data?.play ||
                data?.wmplay ||
                data?.hdplay ||
                data?.video?.play_addr?.url_list?.[0];

            if (!videoUrl) {
                throw new Error("Tikwm returned no video URL");
            }

            const buffer = await downloadBuffer(videoUrl);

            return {
                buffer,
                url: videoUrl,
                author:
                    data?.author?.nickname ||
                    data?.author?.unique_id ||
                    "Unknown"
            };
        },

        async () => {
            const response = await http.get(
                "https://api.siputzx.my.id/api/tiktok",
                {
                    params: { url },
                    timeout: TIMEOUT
                }
            );

            const data = response.data?.data || response.data;
            const videoUrl =
                data?.videoNoWatermark ||
                data?.video ||
                data?.play ||
                data?.url;

            if (!videoUrl) {
                throw new Error("TikTok service returned no video URL");
            }

            const buffer = await downloadBuffer(videoUrl);

            return {
                buffer,
                url: videoUrl,
                author: data?.author || data?.nickname || "Unknown"
            };
        }
    ];

    for (const service of services) {
        try {
            const result = await service();

            if (result?.buffer?.length) {
                return result;
            }
        } catch (error) {
            console.error(
                "[TikTok API fallback]",
                error?.message || error
            );
        }
    }

    try {
        return await ytDlpSocialDownload(url);
    } catch (error) {
        console.error(
            "[TikTok yt-dlp fallback]",
            error?.message || error
        );
    }

    return null;
}

async function ytSearch(query) {
    if (!query || !String(query).trim()) {
        throw new Error("A YouTube search query is required");
    }

    const ytSearchModule = require("yt-search");
    const search = ytSearchModule.default || ytSearchModule;
    const result = await search(String(query));

    return (result.videos || []).slice(0, 10);
}

async function ytDownload(url) {
    if (!validUrl(url)) {
        throw new Error("A valid YouTube URL is required");
    }

    const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "king-red-audio-")
    );

    const outputTemplate = path.join(tempDir, "audio.%(ext)s");

    try {
        await execFileAsync(
            YTDLP_BIN,
            [
                "--no-playlist",
                "--no-warnings",
                "--max-filesize", `${MAX_MEDIA_BYTES}`,
                "-f", "bestaudio/best",
                "-x",
                "--audio-format", "mp3",
                "--audio-quality", "5",
                "-o", outputTemplate,
                url
            ],
            { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
        );

        const files = await fs.promises.readdir(tempDir);
        const audioFile = files.find(
            file => /\.(mp3|m4a|opus|ogg|wav|webm)$/i.test(file)
        );

        if (!audioFile) {
            throw new Error("No audio file was created");
        }

        const filePath = path.join(tempDir, audioFile);
        const stat = await fs.promises.stat(filePath);

        if (!stat.size || stat.size > MAX_MEDIA_BYTES) {
            throw new Error("Audio is empty or too large");
        }

        return {
            buffer: await fs.promises.readFile(filePath),
            title: path.parse(audioFile).name,
            mimetype: audioFile.endsWith(".mp3")
                ? "audio/mpeg"
                : "application/octet-stream"
        };
    } finally {
        await fs.promises.rm(tempDir, {
            recursive: true,
            force: true
        }).catch(() => {});
    }
}

async function facebookDownload(url) {
    if (!validUrl(url)) {
        throw new Error("A valid Facebook video URL is required");
    }

    try {
        return await ytDlpSocialDownload(url);
    } catch (error) {
        console.error("[Facebook download]", error?.message || error);
        return null;
    }
}

async function igDownload(url) {
    if (!validUrl(url)) {
        throw new Error("A valid Instagram URL is required");
    }

    try {
        return await ytDlpSocialDownload(url);
    } catch (error) {
        console.error("[Instagram download]", error?.message || error);
        return null;
    }
}

async function getLyrics(query) {
    if (!query || !String(query).trim()) {
        throw new Error("A song name is required");
    }

    const response = await http.get(
        "https://api.lyrics.ovh/v1/" +
        encodeURIComponent(String(query).trim().split(" ")[0]) +
        "/" +
        encodeURIComponent(
            String(query).trim().split(" ").slice(1).join(" ")
        )
    );

    return response.data?.lyrics || null;
}

module.exports = {
    ytSearch,
    ytDownload,
    ytDlpSocialDownload,
    tiktokDownload,
    facebookDownload,
    igDownload,
    getLyrics
};
            
