/**
 * M4TR1X - AI Detector (Node.js + ONNX Runtime)
 * Traduzione completa di ai_detector.py senza Python.
 *
 * Dipendenze: onnxruntime-node, sharp, ffmpeg-static (opzionale)
 * Runtime: usa ffmpeg-static se installato, altrimenti cerca ffmpeg nel sistema.
 */

const ort = require('onnxruntime-node')
const sharp = require('sharp')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const os = require('os')

// ─── ffmpeg / ffprobe: usa binari bundlati se disponibili, altrimenti sistema ──
let ffmpegBin  = 'ffmpeg'
let ffprobeBin = 'ffprobe'
try {
  ffmpegBin  = require('ffmpeg-static')
  console.log(`[AI] ffmpeg bundled: ${ffmpegBin}`)
} catch (_) {
  console.log('[AI] ffmpeg-static not found — using system ffmpeg. Install with: npm install ffmpeg-static')
}
try {
  const ffprobeStatic = require('ffprobe-static')
  ffprobeBin = ffprobeStatic.path || ffprobeStatic
  console.log(`[AI] ffprobe bundled: ${ffprobeBin}`)
} catch (_) {
  console.log('[AI] ffprobe-static not found — using system ffprobe.')
}

// ─── Costanti (identiche a ai_detector.py) ───────────────────────────────────
const CONFIDENCE_THRESHOLD = 0.55   // lowered: model biased towards REAL, accept 55%+ confidence
const MAX_FRAMES = 16
const FRAME_SIZE = 224

// ImageNet normalization — stessi valori di torchvision.transforms.Normalize
const MEAN = [0.485, 0.456, 0.406]
const STD  = [0.229, 0.224, 0.225]

// ─── Percorso modello ONNX ────────────────────────────────────────────────────
function getModelPath() {
  // In produzione Electron il modello è in resources/models/
  const prodPath = path.join(process.resourcesPath || '', 'models', 'm4tr1x_detector.onnx')
  const devPath  = path.join(__dirname, '..', 'models', 'm4tr1x_detector.onnx')
  return fs.existsSync(prodPath) ? prodPath : devPath
}

let session = null

async function loadModel() {
  const modelPath = getModelPath()
  if (fs.existsSync(modelPath)) {
    session = await ort.InferenceSession.create(modelPath)
    console.log(`[AI] ONNX model loaded: ${modelPath}`)
  } else {
    console.warn('[AI] ONNX model not found. Detection running in fallback mode (UNCERTAIN).')
  }
}

// ─── Estrazione frame con ffmpeg ──────────────────────────────────────────────
function extractFrames(videoPath, numFrames = MAX_FRAMES) {
  const tempDir = path.join(os.tmpdir(), `m4tr1x_${Date.now()}`)
  fs.mkdirSync(tempDir, { recursive: true })

  // Ottieni durata video con ffprobe
  const probe = spawnSync(ffprobeBin, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    videoPath,
  ])

  if (probe.error) {
    throw new Error('ffprobe not found. Install ffmpeg: https://ffmpeg.org/download.html')
  }

  let duration = 10
  try {
    const info = JSON.parse(probe.stdout.toString())
    const vs = info.streams?.find(s => s.codec_type === 'video')
    duration = parseFloat(vs?.duration || 10)
  } catch (_) {}

  // Estrai frame equidistanti (stesso approccio di np.linspace in Python)
  const framePaths = []
  for (let i = 0; i < numFrames; i++) {
    const timeOffset = ((duration * i) / numFrames).toFixed(3)
    const framePath  = path.join(tempDir, `frame_${String(i).padStart(3, '0')}.jpg`)

    const result = spawnSync(ffmpegBin, [
      '-ss', timeOffset,
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      '-y',
      framePath,
    ], { stdio: 'pipe' })

    if (fs.existsSync(framePath)) {
      framePaths.push(framePath)
    }
  }

  console.log(`[AI] Estratti ${framePaths.length}/${numFrames} frame`)
  return { framePaths, tempDir }
}

// ─── Preprocessing frame (replica PyTorch transforms) ─────────────────────────
async function preprocessFrame(imagePath) {
  const { data, info } = await sharp(imagePath)
    .resize(FRAME_SIZE, FRAME_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const channels  = info.channels  // 3 = RGB
  const float32   = new Float32Array(3 * FRAME_SIZE * FRAME_SIZE)

  // HWC → CHW + normalizzazione ImageNet
  for (let h = 0; h < FRAME_SIZE; h++) {
    for (let w = 0; w < FRAME_SIZE; w++) {
      const pixelIdx = (h * FRAME_SIZE + w) * channels
      for (let c = 0; c < 3; c++) {
        const value      = data[pixelIdx + c] / 255.0
        const normalized = (value - MEAN[c]) / STD[c]
        float32[c * FRAME_SIZE * FRAME_SIZE + h * FRAME_SIZE + w] = normalized
      }
    }
  }

  return float32
}

// ─── Analisi singolo frame ────────────────────────────────────────────────────
async function analyzeFrame(imagePath) {
  // Fallback se il modello non è caricato
  if (!session) {
    const real = 0.45 + Math.random() * 0.1
    return {
      label: 'UNCERTAIN',
      confidence: 0.5,
      probabilities: { real: parseFloat(real.toFixed(4)), ai_generated: parseFloat((1 - real).toFixed(4)) },
    }
  }

  const tensorData = await preprocessFrame(imagePath)
  const tensor     = new ort.Tensor('float32', tensorData, [1, 3, FRAME_SIZE, FRAME_SIZE])
  const results    = await session.run({ frame: tensor })
  const logits     = Array.from(results.prediction.data)

  // Softmax
  const maxVal  = Math.max(...logits)
  const exps    = logits.map(v => Math.exp(v - maxVal))
  const sumExps = exps.reduce((a, b) => a + b, 0)
  const probs   = exps.map(v => v / sumExps)

  const realProb = probs[0]
  const aiProb   = probs[1]
  const label    = realProb >= aiProb ? 'REAL' : 'AI_GENERATED'
  const conf     = Math.max(realProb, aiProb)

  return {
    label,
    confidence: parseFloat(conf.toFixed(4)),
    probabilities: {
      real:         parseFloat(realProb.toFixed(4)),
      ai_generated: parseFloat(aiProb.toFixed(4)),
    },
  }
}

// ─── Hash SHA-256 del file video (stream — evita OOM con file grandi) ─────────
function computeVideoHash(videoPath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256')
    const stream = fs.createReadStream(videoPath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end',  () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// ─── Pipeline completa (uguale a analyze_video in Python) ─────────────────────
async function analyzeVideo(videoPath) {
  const videoHash = await computeVideoHash(videoPath)
  let frameResults = []
  let tempDir      = null

  try {
    const { framePaths, tempDir: td } = extractFrames(videoPath)
    tempDir = td

    for (let i = 0; i < framePaths.length; i++) {
      const result = await analyzeFrame(framePaths[i])
      frameResults.push({ ...result, frame_index: i })
    }
  } catch (err) {
    console.error('[AI] Frame extraction error:', err.message)
    return {
      status: 'ERROR',
      error: err.message,
      video_hash_sha256: videoHash,
      timestamp: new Date().toISOString(),
    }
  } finally {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }

  if (frameResults.length === 0) {
    return { status: 'ERROR', error: 'No frames extracted', video_hash_sha256: videoHash }
  }

  // Media pesata con più peso ai frame centrali (identica a Python)
  const n      = frameResults.length
  const center = Math.floor(n / 2)
  const weights     = frameResults.map((_, i) => {
    const dist = Math.abs(i - center) / Math.max(center, 1)
    return 1.0 + (1.0 - dist) * 0.5
  })
  const weightSum   = weights.reduce((a, b) => a + b, 0)
  const normWeights = weights.map(w => w / weightSum)

  const realScores = frameResults.map(f => f.probabilities.real)
  const aiScores   = frameResults.map(f => f.probabilities.ai_generated)

  const avgReal = realScores.reduce((sum, s, i) => sum + s * normWeights[i], 0)
  const avgAi   = aiScores.reduce((sum, s, i)   => sum + s * normWeights[i], 0)

  // Verdetto
  let verdict, verdictEmoji
  if (avgAi > CONFIDENCE_THRESHOLD) {
    verdict = 'AI_GENERATED'; verdictEmoji = '⚠️'
  } else if (avgReal > CONFIDENCE_THRESHOLD) {
    verdict = 'AUTHENTIC';    verdictEmoji = '✅'
  } else {
    verdict = 'UNCERTAIN';    verdictEmoji = '❓'
  }

  // Consistency score (identico a Python: 1 - std * 2)
  const mean       = avgAi
  const variance   = aiScores.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / aiScores.length
  const std        = Math.sqrt(variance)
  const consistency = Math.max(0, 1.0 - std * 2)

  return {
    status: 'OK',
    video_hash_sha256: videoHash,
    timestamp: new Date().toISOString(),
    verdict,
    verdict_emoji: verdictEmoji,
    confidence: {
      authentic:    parseFloat(avgReal.toFixed(4)),
      ai_generated: parseFloat(avgAi.toFixed(4)),
    },
    consistency_score: parseFloat(consistency.toFixed(4)),
    frames_analyzed: frameResults.length,
    frame_details: frameResults,
    model_info: {
      name:     'M4TR1X-Detector-v1',
      backbone: 'EfficientNet-B0',
      runtime:  session ? 'ONNX Runtime (Node.js)' : 'Fallback (no model)',
    },
  }
}

// Carica il modello all'avvio
loadModel().catch(console.error)

module.exports = { analyzeVideo, loadModel }
