const detectTrim = require("./module/detectTrim");
const { execa } = require("execa");

(async () => {

    const trim = await detectTrim("mp4/input.mp4");

    console.log(trim);
    let VidoeSettings ={
        margin_top:16,
        margin_side:20,
        camera_width:622,
        camera_height:304
    }
    let margin_side_2nd = 1920-VidoeSettings.camera_width-VidoeSettings.margin_side;
    let command='ffmpeg'
    let filterComplex = `
    [0:v]
    crop=1920:1080:1920:1080
    [main];

    [0:v]
    crop=1920:980:0:0,
    scale=${VidoeSettings.camera_width}:${VidoeSettings.camera_height}
    [cam1];

    [0:v]
    crop=1920:980:1920:0,
    scale=${VidoeSettings.camera_width}:${VidoeSettings.camera_height}
    [cam2];

    [cam1][1:v]
    alphamerge
    [cam1masked];


    [cam2][1:v]
    alphamerge
    [cam2masked];

    [main][cam1masked]
    overlay=${VidoeSettings.margin_side}:${VidoeSettings.margin_top}
    [tmp1];

    [tmp1][cam2masked]
    overlay=${margin_side_2nd}:${VidoeSettings.margin_top},
    format=nv12,
    hwupload
    [out];

    [0:a:1][0:a:0]sidechaincompress=
    threshold=0.03:
    ratio=8:
    attack=10:
    release=400:
    makeup=1
    [ducked];

    [ducked][0:a:0]amix=inputs=2:weights='1 1':normalize=0[aout]
    `;
    let options = [
        '-vaapi_device','/dev/dri/renderD128',
        "-ss", (trim.start / 1000).toFixed(3),
        "-to", (trim.end / 1000).toFixed(3),
        '-i', 'input.mp4',
        '-i', 'camera-mask.png',
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-map', '[aout]',
        '-c:v', 'h264_vaapi',
        '-qp','22',
        '-c:a','aac',
        '-b:a','256k',
        'mp4/output-audio-ducked.mp4'
    ]
    await execa(command,options,{
    stdout: "inherit",
    stderr: "inherit"
    });

})();