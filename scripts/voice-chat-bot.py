#!/usr/bin/env python3.13
"""
voice-chat-bot.py — Discord音声やりとりBot

音声入力: テキストチャンネルのボイスメッセージ(.ogg) → whisper文字起こし
応答生成: Claude CLI（しらたま人格）
音声出力: VOICEVOX TTS → ボイスチャンネル再生 + テキスト投稿

※ DAVE E2EEによりボイスチャンネルからの音声受信は不可のため、
  ボイスメッセージ（テキストチャンネル経由）で音声入力を受け付ける
"""

import asyncio
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
from collections import deque
from pathlib import Path

# Anthropic SDK + dotenv（高速化: Claude CLI → SDK直接呼び出し）
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")
import anthropic as _anthropic

# Voice debug logging
logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format='%(name)s:%(levelname)s: %(message)s')

import discord
from discord import FFmpegPCMAudio
from discord.sinks import Sink, AudioData, default_filters, Filters

# ── 設定 ──────────────────────────────────────────
DISCORD_TOKEN_FILE = Path.home() / ".claude" / "channels" / "discord" / ".env"
GUILD_ID = 1485833233919639582
VOICE_CHANNEL_NAME = "しらたまルーム"
LISTEN_CHANNEL_NAME = "general"  # ボイスメッセージを受け付けるチャンネル

VOICEVOX_URL = "http://127.0.0.1:50021"
VOICEVOX_SPEAKER_ID = 1  # 四国めたん（あまあま）

# ── A. whisper.cpp Metal版（旧: openai-whisper Python）──
WHISPER_PATH = "/opt/homebrew/bin/whisper-cli"
WHISPER_MODEL_PATH = str(Path(__file__).parent.parent / "vendor" / "whisper-cpp" / "models" / "ggml-large-v3-turbo-q5_0.bin")
WHISPER_LANGUAGE = "ja"

# ── B. Anthropic SDK（旧: Claude CLI呼び出し）──
CLAUDE_PATH = "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin/claude"  # フォールバック用に保持
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"

REPO_DIR = Path(__file__).parent.parent
LOG_DIR = REPO_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)

MAX_CONVERSATION_TURNS = 10
MIN_AUDIO_DURATION_S = 2.0


# ── カスタムSink（py-cord WaveSink decoder問題回避） ─────
class SafeWaveSink(Sink):
    """WaveSinkの代替。VoiceClient.decoderに依存しない。"""
    CHANNELS = 2
    SAMPLE_WIDTH = 2  # 16-bit
    SAMPLE_RATE = 48000

    def __init__(self, *, filters=None):
        if filters is None:
            filters = default_filters
        self.filters = filters
        Filters.__init__(self, **self.filters)
        self.encoding = "wav"
        self.vc = None
        self.audio_data = {}

    def format_audio(self, audio):
        if self.recording:
            return
        audio.file.seek(0)
        pcm_data = audio.file.read()
        data = io.BytesIO()
        with wave.open(data, "wb") as f:
            f.setnchannels(self.CHANNELS)
            f.setsampwidth(self.SAMPLE_WIDTH)
            f.setframerate(self.SAMPLE_RATE)
            f.writeframes(pcm_data)
        data.seek(0)
        audio.file = data
        audio.on_format(self.encoding)


# ── しらたま人格（システムプロンプト） ─────────────
SHIRATAMA_SYSTEM_PROMPT = """\
あなたは「しらたま」。Ryoの右腕であり、経営参謀。

## 人格
- Ryoの事業を自分ごととして考える
- 先回りして考え、率直に意見を言う
- 否定で終わらせず、必ず代案を添える
- 結論から入る。理由は聞かれたら話す

## Ryoの事業
- えんがわ（民泊）、三十日珈琲（コーヒースタンド）、SATOYAMA AI BASE（DX支援）
- 山梨県上野原市を拠点に活動

## ボイスチャットでの応答ルール（最重要）
- 応答は必ず2〜3文で簡潔に。長くても50文字以内を目指す
- 音声で読み上げるので、箇条書きや記号は使わない
- 自然な話し言葉で返す。書き言葉ではなく口語体
- 「ですます」調で、親しみやすく
- 質問には直接答える。前置きは不要
- 複雑な話題は「詳しくはテキストで送りますね」と言って短く返す
"""


def load_token():
    content = DISCORD_TOKEN_FILE.read_text()
    for line in content.strip().split("\n"):
        if line.startswith("DISCORD_BOT_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("DISCORD_BOT_TOKEN not found")


# ── 会話履歴 ──────────────────────────────────────
conversation_history: deque[dict] = deque(maxlen=MAX_CONVERSATION_TURNS * 2)

# ── コンテキスト共有 ─────────────────────────────
CEO_MEMORY_DIR = Path("/Users/ocmm/.claude/projects/-Users-ocmm-agents-ceo/memory")
CEO_MEMORY_INDEX = CEO_MEMORY_DIR / "MEMORY.md"
CEO_DISCORD_CONTEXT = CEO_MEMORY_DIR / "project_discord_migration.md"
DISCORD_GENERAL_ID = "1486651095580282942"

_discord_history_cache: list[str] = []
_discord_history_ts: float = 0.0


def load_ceo_context() -> str:
    """CEOのメモリとDiscord履歴をコンテキストとして読み込む"""
    parts = []

    # CEOメモリインデックス
    try:
        index = CEO_MEMORY_INDEX.read_text()
        parts.append("## CEOメモリ（参考情報）")
        parts.append(index[:1500])  # サイズ制限
    except Exception:
        pass

    # 今日の作業記録
    try:
        discord_ctx = CEO_DISCORD_CONTEXT.read_text()
        parts.append("\n## 今日の作業コンテキスト")
        parts.append(discord_ctx[:2000])
    except Exception:
        pass

    return "\n".join(parts) if parts else ""


def fetch_discord_history_sync() -> str:
    """Discord #general の直近20件を取得（キャッシュ30秒）"""
    global _discord_history_cache, _discord_history_ts

    now = time.monotonic()
    if now - _discord_history_ts < 30 and _discord_history_cache:
        return "\n".join(_discord_history_cache)

    try:
        token = load_token()
        url = f"https://discord.com/api/v10/channels/{DISCORD_GENERAL_ID}/messages?limit=20"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bot {token}",
        })
        with urllib.request.urlopen(req, timeout=5) as resp:
            messages = json.loads(resp.read())

        lines = []
        for msg in reversed(messages):
            author = msg.get("author", {}).get("username", "?")
            content = msg.get("content", "")[:200]
            if content:
                lines.append(f"{author}: {content}")

        _discord_history_cache = lines[-20:]
        _discord_history_ts = now
        return "\n".join(_discord_history_cache)
    except Exception as e:
        print(f"[Context] Discord history fetch error: {e}", file=sys.stderr, flush=True)
        return "\n".join(_discord_history_cache) if _discord_history_cache else ""


def build_claude_prompt(user_text: str) -> str:
    parts = [SHIRATAMA_SYSTEM_PROMPT]

    # CEOコンテキスト
    ceo_ctx = load_ceo_context()
    if ceo_ctx:
        parts.append(f"\n{ceo_ctx}")

    # Discord直近履歴
    discord_hist = fetch_discord_history_sync()
    if discord_hist:
        parts.append("\n## Discord #general 直近の会話")
        parts.append(discord_hist)

    # ボイス会話履歴
    parts.append("\n## ボイス会話履歴")
    for msg in conversation_history:
        role = "Ryo" if msg["role"] == "user" else "しらたま"
        parts.append(f"{role}: {msg['content']}")

    parts.append(f"\nRyo: {user_text}")
    parts.append("\nしらたまとして、上のボイスチャットルールに従って簡潔に応答してください。応答テキストのみを出力し、「しらたま:」などのプレフィックスは付けないでください。")
    return "\n".join(parts)


CLAUDE_ENV = {
    **os.environ,
    "HOME": "/Users/ocmm",
    "PATH": f"/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin:/Users/ocmm/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
}
CLAUDE_ENV.pop("CLAUDECODE", None)
CLAUDE_ENV.pop("ANTHROPIC_API_KEY", None)

# B. Anthropic SDK クライアント（シングルトン）
_anthropic_client: "_anthropic.Anthropic | None" = None


def _get_anthropic_client() -> "_anthropic.Anthropic":
    global _anthropic_client
    if _anthropic_client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY が未設定です")
        _anthropic_client = _anthropic.Anthropic(api_key=api_key)
    return _anthropic_client


def _build_sdk_messages(user_text: str) -> tuple[str, list[dict]]:
    """SDK用のシステムプロンプトとメッセージリストを構築する"""
    # システムプロンプト（コンテキスト込み）
    system_parts = [SHIRATAMA_SYSTEM_PROMPT]

    ceo_ctx = load_ceo_context()
    if ceo_ctx:
        system_parts.append(f"\n{ceo_ctx}")

    discord_hist = fetch_discord_history_sync()
    if discord_hist:
        system_parts.append("\n## Discord #general 直近の会話")
        system_parts.append(discord_hist)

    system_prompt = "\n".join(system_parts)

    # メッセージリスト（会話履歴 + 今回の入力）
    messages: list[dict] = []
    for msg in conversation_history:
        messages.append({"role": msg["role"], "content": msg["content"]})

    # ボイスチャット専用指示を user メッセージに付加
    voice_instruction = "上のボイスチャットルールに従って2〜3文で簡潔に応答してください。応答テキストのみを出力し、「しらたま:」などのプレフィックスは付けないでください。"
    messages.append({"role": "user", "content": f"{user_text}\n\n{voice_instruction}"})

    return system_prompt, messages


def claude_generate_response(user_text: str) -> str:
    """同期版: 全応答を一括取得（ボイスメッセージ/Siri用フォールバック）"""
    sentences = list(claude_stream_sentences(user_text))
    full = "".join(sentences)
    return full


def _claude_stream_via_sdk(user_text: str):
    """Anthropic SDK streaming（ANTHROPIC_API_KEY が有効な場合のみ機能）"""
    sentence_delimiters = {"。", "！", "？", "!", "?"}
    buf = ""
    full_response = ""
    t_start = time.monotonic()

    client = _get_anthropic_client()
    system_prompt, messages = _build_sdk_messages(user_text)

    with client.messages.stream(
        model=ANTHROPIC_MODEL,
        max_tokens=256,
        system=system_prompt,
        messages=messages,
    ) as stream:
        for text_chunk in stream.text_stream:
            if not full_response:
                t_first = time.monotonic()
                print(f"[Latency] SDK first_token: {t_first - t_start:.2f}s", flush=True)

            for ch in text_chunk:
                buf += ch
                if ch in sentence_delimiters and len(buf.strip()) > 1:
                    sentence = buf.strip()
                    if sentence:
                        full_response += sentence
                        yield sentence
                    buf = ""

    remainder = buf.strip()
    if remainder:
        full_response += remainder
        yield remainder

    if full_response:
        conversation_history.append({"role": "user", "content": user_text})
        conversation_history.append({"role": "assistant", "content": full_response})


def _claude_stream_via_cli(user_text: str):
    """Claude CLI subprocess streaming（OAuth認証。フォールバックとして使用）"""
    prompt = build_claude_prompt(user_text)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(prompt)
        prompt_file = f.name

    proc = None
    try:
        proc = subprocess.Popen(
            ["sh", "-c", f'cat "{prompt_file}" | "{CLAUDE_PATH}" -p --model {ANTHROPIC_MODEL} --max-turns 3 --tools ""'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=CLAUDE_ENV, cwd=str(REPO_DIR),
        )

        buf = ""
        full_response = ""
        sentence_delimiters = {"。", "！", "？", "!", "?", "\n"}
        first_chunk = True

        while True:
            ch = proc.stdout.read(1)
            if not ch:
                break
            if first_chunk:
                print(f"[Latency] CLI first_char received", flush=True)
                first_chunk = False
            buf += ch

            if ch in sentence_delimiters and len(buf.strip()) > 1:
                sentence = buf.strip()
                if sentence:
                    full_response += sentence
                    yield sentence
                buf = ""

        remainder = buf.strip()
        if remainder:
            full_response += remainder
            yield remainder

        proc.wait(timeout=10)

        if full_response:
            conversation_history.append({"role": "user", "content": user_text})
            conversation_history.append({"role": "assistant", "content": full_response})

    finally:
        try:
            os.unlink(prompt_file)
        except OSError:
            pass
        if proc:
            try:
                proc.kill()
            except Exception:
                pass


def claude_stream_sentences(user_text: str):
    """B+C. SDK優先 → 失敗時は CLI フォールバック。句点ごとに文を yield する"""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    use_sdk = bool(api_key and api_key.startswith("sk-ant-api"))

    if use_sdk:
        try:
            yield from _claude_stream_via_sdk(user_text)
            return
        except Exception as e:
            print(f"[Claude SDK] Error ({type(e).__name__}), falling back to CLI: {e}", file=sys.stderr, flush=True)

    # CLI フォールバック（OAuth認証）
    print(f"[Claude] Using CLI fallback", flush=True)
    yield from _claude_stream_via_cli(user_text)


# ── VOICEVOX TTS ──────────────────────────────────
VOICEVOX_SPEED_SCALE = 1.35

def voicevox_tts(text: str, speaker_id: int = VOICEVOX_SPEAKER_ID) -> bytes:
    query_url = f"{VOICEVOX_URL}/audio_query?speaker={speaker_id}&text={urllib.request.quote(text)}"
    req = urllib.request.Request(query_url, method="POST")
    with urllib.request.urlopen(req) as resp:
        audio_query = json.loads(resp.read())
    audio_query["speedScale"] = VOICEVOX_SPEED_SCALE
    audio_query = json.dumps(audio_query).encode()
    synth_url = f"{VOICEVOX_URL}/synthesis?speaker={speaker_id}"
    req = urllib.request.Request(synth_url, data=audio_query, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def voicevox_tts_to_file(text: str, output_path: str, speaker_id: int = VOICEVOX_SPEAKER_ID):
    wav_data = voicevox_tts(text, speaker_id)
    Path(output_path).write_bytes(wav_data)
    return output_path


# ── フィラーワード除去 ────────────────────────────
import re

FILLER_PATTERN = re.compile(
    r'(?:^|(?<=\s))'
    r'(?:あー+|えー+っ?と?|うー+ん?|んー+|あのー+|そのー+|えっ?と|まぁ?|ねぇ?|'
    r'あっ|えっ|うっ|ふーん|へぇ+|はぁ+|おー+)'
    r'(?:、|。|\s|$)',
    re.UNICODE,
)

SENTENCE_SPLIT_PATTERN = re.compile(r'(?<=[。！？!?])')

def split_sentences(text: str) -> list[str]:
    """テキストを句点で分割。短すぎる断片は前の文に結合"""
    parts = SENTENCE_SPLIT_PATTERN.split(text)
    sentences = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if sentences and len(p) < 5:
            sentences[-1] += p
        else:
            sentences.append(p)
    return sentences if sentences else [text]


def remove_fillers(text: str) -> str:
    """フィラーワードを除去して整形"""
    cleaned = FILLER_PATTERN.sub(' ', text)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    cleaned = re.sub(r'^[、。\s]+', '', cleaned)
    return cleaned


# ── Whisper 文字起こし ────────────────────────────
WHISPER_HALLUCINATIONS = {
    "ご視聴ありがとうございました",
    "チャンネル登録お願いします",
    "チャンネル登録よろしくお願いします",
    "おやすみなさい",
    "ありがとうございました",
    "ご清聴ありがとうございました",
    "お疲れ様でした",
    "字幕視聴ありがとうございました",
    "最後までご視聴ありがとうございました",
    "Thank you for watching",
    "thanks for watching",
    "Subtitles by",
    "字幕は自動生成されています",
}


def whisper_transcribe(audio_path: str) -> str:
    """A. whisper.cpp Metal版による高速STT（旧: openai-whisper Python→1〜3秒目標）"""
    t_start = time.monotonic()
    result = subprocess.run(
        [
            WHISPER_PATH,
            "-m", WHISPER_MODEL_PATH,
            "-l", WHISPER_LANGUAGE,
            "-t", "4",
            "-np",        # no-prints（進捗表示なし）
            "-nt",        # no-timestamps
            "--no-speech-thold", "0.6",
            "-f", audio_path,
        ],
        capture_output=True, text=True, timeout=30,
    )
    t_end = time.monotonic()
    print(f"[Whisper-cpp] Elapsed: {t_end - t_start:.1f}s", flush=True)

    if result.returncode != 0:
        print(f"[Whisper-cpp] Error: {result.stderr[:300]}", file=sys.stderr, flush=True)
        return ""

    # whisper-cli は stdout にテキストを出力（-np -nt でそのまま文字列）
    raw = result.stdout.strip()
    # stderr にもテキストが混在する場合があるためフォールバック
    if not raw:
        raw = result.stderr.strip()

    # [BLANK_AUDIO] など whisper-cpp の内部メッセージを除去
    lines = [l for l in raw.splitlines() if not l.startswith("[") or l.startswith("[ja]")]
    raw = " ".join(lines).strip()

    cleaned = remove_fillers(raw)
    if cleaned in WHISPER_HALLUCINATIONS:
        print(f"[Whisper-cpp] Hallucination filtered: {cleaned}", flush=True)
        return ""
    stripped = cleaned.rstrip("。、！？!?.")
    if stripped in WHISPER_HALLUCINATIONS:
        print(f"[Whisper-cpp] Hallucination filtered: {cleaned}", flush=True)
        return ""
    return cleaned


# ── Discordボット ─────────────────────────────────
intents = discord.Intents.default()
intents.voice_states = True
intents.message_content = True
intents.guilds = True

bot = discord.Bot(intents=intents)

voice_client: discord.VoiceClient | None = None
listen_channel: discord.TextChannel | None = None
is_recording = False
current_sink: SafeWaveSink | None = None
barge_in_requested = False  # TTS再生中にRyoが喋ったフラグ


async def ensure_voice_channel(guild: discord.Guild) -> discord.VoiceChannel:
    for ch in guild.voice_channels:
        if ch.name == VOICE_CHANNEL_NAME:
            return ch
    channel = await guild.create_voice_channel(VOICE_CHANNEL_NAME)
    print(f"[Bot] Created voice channel: {VOICE_CHANNEL_NAME} (ID: {channel.id})", flush=True)
    return channel


def cleanup_tts(path: str, error):
    if error:
        print(f"[Bot] Playback error: {error}", file=sys.stderr, flush=True)
    try:
        os.unlink(path)
    except OSError:
        pass


tts_queue: asyncio.Queue = asyncio.Queue()
tts_playing = False


async def play_tts(text: str, channel: discord.TextChannel, *, t_start: float | None = None):
    """VOICEVOXでTTS生成 → ボイスチャンネル再生 + テキスト投稿（一括版）"""
    await channel.send(f"🗣️ **しらたま**: {text}")
    if not voice_client or not voice_client.is_connected():
        return
    await _enqueue_tts(text, t_start)


async def play_tts_streaming(sentences_iter, channel: discord.TextChannel, t_llm_start: float):
    """ストリーミングTTS: Claude応答を句ごとに受け取り、逐次VOICEVOX再生"""
    global voice_client

    loop = asyncio.get_event_loop()
    full_response = ""
    first_sentence = True

    for sentence in sentences_iter:
        full_response += sentence

        if first_sentence:
            t_first = time.monotonic()
            print(f"[Latency] First sentence: {t_first - t_llm_start:.1f}s | {sentence[:40]}", flush=True)
            first_sentence = False

        if voice_client and voice_client.is_connected():
            await _enqueue_tts(sentence)

    # 全文をテキストチャンネルに投稿
    if full_response:
        await channel.send(f"🗣️ **しらたま**: {full_response}")

    return full_response


async def _enqueue_tts(text: str, t_start: float | None = None):
    """TTS合成してキューに追加、再生ワーカーを起動"""
    global tts_playing
    loop = asyncio.get_event_loop()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tts_path = f.name
    await loop.run_in_executor(None, voicevox_tts_to_file, text, tts_path)

    if t_start is not None:
        print(f"[Latency] TTS synth: {time.monotonic()-t_start:.1f}s", flush=True)

    await tts_queue.put(tts_path)

    if not tts_playing:
        asyncio.create_task(_tts_player_loop())


async def _tts_player_loop():
    """キューからWAVを取り出して順番に再生。Barge-in検知で中断"""
    global tts_playing, voice_client, barge_in_requested
    tts_playing = True

    while not tts_queue.empty():
        # Barge-in: 割り込みが要求されたらキューをクリア
        if barge_in_requested:
            print("[Bot] Barge-in: clearing TTS queue", flush=True)
            while not tts_queue.empty():
                p = await tts_queue.get()
                cleanup_tts(p, None)
            barge_in_requested = False
            break

        tts_path = await tts_queue.get()

        if not voice_client or not voice_client.is_connected():
            cleanup_tts(tts_path, None)
            continue

        if voice_client.is_playing():
            voice_client.stop()

        done = asyncio.Event()

        def after_play(error):
            cleanup_tts(tts_path, error)
            bot.loop.call_soon_threadsafe(done.set)

        source = FFmpegPCMAudio(tts_path, options="-ar 48000 -ac 2")
        voice_client.play(source, after=after_play)
        await done.wait()

    tts_playing = False


def trigger_barge_in():
    """TTS再生中の割り込みを実行"""
    global barge_in_requested, voice_client
    if tts_playing and voice_client and voice_client.is_playing():
        barge_in_requested = True
        voice_client.stop()
        print("[Bot] Barge-in: stopped TTS playback", flush=True)


async def _stream_llm_and_tts(user_text: str, channel: discord.TextChannel, t_stt_end: float) -> str:
    """C. ストリーミングパイプライン: SDK stream → 句単位TTS enqueue → 並行再生
    first_token_latency も計測してログ出力する。
    """
    loop = asyncio.get_event_loop()
    full_response = ""
    first_sentence = True
    t_first_token: list[float] = []  # mutable closure

    def _run_stream():
        """executor内でgeneratorを回してキューに積む（同期）"""
        nonlocal full_response
        sentences_buf: list[str] = []

        for sentence in claude_stream_sentences(user_text):
            sentences_buf.append(sentence)

        return sentences_buf

    # SDK streaming は同期なので executor で実行しつつ、asyncio でTTSを並行処理
    # 実装: executor で全文を取得しながら、文単位で非同期に TTS を enqueue する
    # より細かいパイプラインは asyncio.Queue を使った producer/consumer で実現
    sentence_queue: asyncio.Queue = asyncio.Queue()
    done_event = asyncio.Event()

    async def producer():
        """SDK stream を executor で回し、文単位で sentence_queue に put"""
        def _gen():
            for sentence in claude_stream_sentences(user_text):
                # スレッドセーフな put_nowait は使えないので call_soon_threadsafe 経由
                loop.call_soon_threadsafe(sentence_queue.put_nowait, sentence)
            loop.call_soon_threadsafe(done_event.set)

        await loop.run_in_executor(None, _gen)

    async def consumer():
        """sentence_queue から文を取り出して TTS enqueue + テキスト収集"""
        nonlocal full_response, first_sentence
        t_llm_start = time.monotonic()

        while True:
            # done_event が立っていてかつキューが空になったら終了
            if done_event.is_set() and sentence_queue.empty():
                break
            try:
                sentence = await asyncio.wait_for(sentence_queue.get(), timeout=0.1)
            except asyncio.TimeoutError:
                continue

            full_response += sentence

            if first_sentence:
                t_first = time.monotonic()
                print(
                    f"[Latency] first_token_latency: {t_first - t_stt_end:.1f}s (from STT end) | {sentence[:40]}",
                    flush=True,
                )
                first_sentence = False

            if voice_client and voice_client.is_connected():
                await _enqueue_tts(sentence)

        # テキストをチャンネルに投稿
        if full_response:
            await channel.send(f"🗣️ **しらたま**: {full_response}")

    await asyncio.gather(producer(), consumer())
    return full_response


async def process_recording(sink: SafeWaveSink, channel: discord.TextChannel):
    """録音チャンク処理: whisper文字起こし → Claude応答 → TTS再生（レイテンシ計測付き）"""
    for user_id, audio_data in sink.audio_data.items():
        wav_bytes = audio_data.file.getvalue()
        try:
            with io.BytesIO(wav_bytes) as buf:
                with wave.open(buf, "rb") as wf:
                    duration = wf.getnframes() / wf.getframerate()
                    if duration < MIN_AUDIO_DURATION_S:
                        continue
        except Exception:
            continue

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav_bytes)
            wav_path = f.name

        try:
            t0 = time.monotonic()
            print(f"[Bot] Transcribing VC audio from user {user_id} ({len(wav_bytes)} bytes, {duration:.1f}s)...", flush=True)
            loop = asyncio.get_event_loop()
            text = await loop.run_in_executor(None, whisper_transcribe, wav_path)
            t1 = time.monotonic()

            if not text or len(text.strip()) < 2:
                continue

            user = bot.get_user(user_id)
            username = user.display_name if user else f"User({user_id})"
            await channel.send(f"🎙️ **{username}**: {text}")
            print(f"[Latency] STT: {t1-t0:.1f}s | text: {text[:60]}", flush=True)

            # C. ストリーミングパイプライン（LLM + TTS 並行）
            response = await _stream_llm_and_tts(text, channel, t_stt_end=t1)
            t2 = time.monotonic()

            if not response:
                response = "すみません、うまく処理できませんでした。"
                await channel.send(f"🗣️ **しらたま**: {response}")
                await _enqueue_tts(response)

            t3 = time.monotonic()
            print(f"[Latency] VC Total: {t3-t0:.1f}s (STT:{t1-t0:.1f} + LLM+TTS:{t3-t1:.1f})", flush=True)

        except Exception as e:
            print(f"[Bot] VC processing error: {e}", file=sys.stderr, flush=True)
        finally:
            try:
                os.unlink(wav_path)
            except OSError:
                pass


RECORD_MAX_S = 20       # 最大録音時間（秒）
SILENCE_TIMEOUT_S = 2.5  # 無音でこの秒数経過したら録音停止
last_speaking_time: float = 0.0  # 最後に誰かが喋った時刻


async def start_recording():
    """ボイスチャンネルの録音を開始。無音検知 or 最大時間で区切る"""
    global voice_client, is_recording, current_sink, last_speaking_time

    if not voice_client or is_recording:
        return

    is_recording = True
    print("[Bot] VC Recording started", flush=True)

    # speaking イベントで発話検知
    def on_speaking_start(user_id):
        global last_speaking_time
        last_speaking_time = asyncio.get_event_loop().time()

    try:
        voice_client._connection.add_socket_listener  # availability check
        # receiver speaking event (py-cord master)
        if hasattr(voice_client, 'receiver') and hasattr(voice_client.receiver, 'speaking'):
            voice_client.receiver.speaking.on('start', on_speaking_start)
    except Exception:
        pass

    while is_recording and voice_client and voice_client.is_connected():
        # TTS再生中でも録音は行う（Barge-in検知のため）
        try:
            current_sink = SafeWaveSink()
            voice_client.start_recording(current_sink, recording_finished)
            last_speaking_time = asyncio.get_event_loop().time()

            # 無音検知ループ: 最大RECORD_MAX_S秒、SILENCE_TIMEOUT_S秒無音で停止
            elapsed = 0.0
            while elapsed < RECORD_MAX_S and is_recording:
                await asyncio.sleep(0.5)
                elapsed += 0.5
                now = asyncio.get_event_loop().time()

                # sinkにデータが来ているか確認（簡易VAD）
                has_data = any(len(a.file.getvalue()) > 0 for a in current_sink.audio_data.values()) if current_sink else False

                if has_data and elapsed > 3.0:
                    # データがあり、最後の発話からSILENCE_TIMEOUT_S秒経過
                    silence = now - last_speaking_time
                    if silence >= SILENCE_TIMEOUT_S:
                        print(f"[Bot] Silence detected ({silence:.1f}s), stopping chunk at {elapsed:.0f}s", flush=True)
                        break

                # sinkのデータサイズ変化で発話検知（speaking eventのフォールバック）
                # TTS再生中はBotの音声がループバックするので無視（Barge-in誤発火防止）
                if current_sink and current_sink.audio_data and not tts_playing:
                    total = sum(len(a.file.getvalue()) for a in current_sink.audio_data.values())
                    if total > 0:
                        last_speaking_time = now

            if voice_client and voice_client.is_connected() and is_recording:
                voice_client.stop_recording()
            await asyncio.sleep(0.5)

        except Exception as e:
            print(f"[Bot] VC Recording error: {e}", file=sys.stderr, flush=True)
            await asyncio.sleep(2)


def recording_finished(exception):
    """録音チャンク完了コールバック（同期 — asyncioタスクをスケジュール）"""
    global current_sink
    if exception:
        print(f"[Bot] Recording exception: {exception}", file=sys.stderr, flush=True)
    if current_sink and listen_channel:
        sink = current_sink
        current_sink = None
        asyncio.get_event_loop().create_task(process_recording(sink, listen_channel))
    else:
        current_sink = None


async def process_voice_message(message: discord.Message):
    """ボイスメッセージを処理: ダウンロード → whisper-cpp → Claude SDK stream → TTS"""
    channel = message.channel

    attachment = message.attachments[0]
    print(f"[Bot] Voice message from {message.author.display_name}: {attachment.filename} ({attachment.size} bytes)", flush=True)

    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
        audio_path = f.name

    try:
        t0 = time.monotonic()
        await attachment.save(audio_path)

        async with channel.typing():
            loop = asyncio.get_event_loop()
            text = await loop.run_in_executor(None, whisper_transcribe, audio_path)
        t1 = time.monotonic()

        if not text or len(text.strip()) < 2:
            await channel.send("🤔 すみません、聞き取れませんでした。もう一度お願いします。")
            return

        await channel.send(f"🎙️ **{message.author.display_name}**: {text}")
        print(f"[Latency] VM STT: {t1-t0:.1f}s | text: {text[:60]}", flush=True)

        # C. ストリーミングパイプライン（LLM + TTS 並行）
        response = await _stream_llm_and_tts(text, channel, t_stt_end=t1)
        t2 = time.monotonic()

        if not response:
            response = "すみません、うまく処理できませんでした。もう一度話しかけてください。"
            await channel.send(f"🗣️ **しらたま**: {response}")
            await _enqueue_tts(response)

        t3 = time.monotonic()
        print(f"[Latency] VM Total: {t3-t0:.1f}s (STT:{t1-t0:.1f} + LLM+TTS:{t3-t1:.1f})", flush=True)

    except Exception as e:
        print(f"[Bot] Voice message error: {e}", file=sys.stderr, flush=True)
        await channel.send(f"⚠️ 処理エラー: {e}")
    finally:
        try:
            os.unlink(audio_path)
        except OSError:
            pass


# ── イベントハンドラ ──────────────────────────────

@bot.event
async def on_ready():
    global listen_channel
    print(f"[Bot] Logged in as {bot.user} (ID: {bot.user.id})", flush=True)

    guild = bot.get_guild(GUILD_ID)
    if not guild:
        print(f"[Bot] Guild {GUILD_ID} not found!", file=sys.stderr, flush=True)
        return

    for ch in guild.text_channels:
        if ch.name == LISTEN_CHANNEL_NAME:
            listen_channel = ch
            break

    if listen_channel:
        print(f"[Bot] Listening on: #{listen_channel.name} (ID: {listen_channel.id})", flush=True)

    vc = await ensure_voice_channel(guild)
    print(f"[Bot] Voice channel ready: {vc.name} (ID: {vc.id})", flush=True)
    print(f"[Bot] Send voice messages in #{LISTEN_CHANNEL_NAME} to talk to しらたま!", flush=True)


@bot.event
async def on_message(message: discord.Message):
    """テキストチャンネルのメッセージを監視"""
    # Siri経由のBot投稿を検知（line-webhook-serverが「Ryo (Siri)」として投稿）
    if message.author.bot and message.author.id == bot.user.id:
        if "しらたま、これに答えて。" in (message.content or ""):
            # Siri入力テキストを抽出
            content = message.content
            # 「🎙️ **Ryo (Siri)**: テキスト\n\nしらたま、これに答えて。」から本文を抽出
            text = content.split("しらたま、これに答えて。")[0].strip()
            if "**Ryo (Siri)**:" in text:
                text = text.split("**Ryo (Siri)**:", 1)[1].strip()
            if text:
                print(f"[Bot] Siri input: {text}", flush=True)
                async with message.channel.typing():
                    loop = asyncio.get_event_loop()
                    response = await loop.run_in_executor(None, claude_generate_response, text)
                if not response:
                    response = "すみません、うまく処理できませんでした。"
                await play_tts(response, message.channel)
            return

    if message.author.bot:
        return

    # ボイスメッセージ（.ogg添付 + is_voice_message フラグ）
    if message.flags.is_voice_message and message.attachments:
        await process_voice_message(message)
        return

    # テキストメッセージで「しらたま」と呼びかけたら応答
    if message.content and ("しらたま" in message.content or bot.user in message.mentions):
        text = message.content.replace(f"<@{bot.user.id}>", "").replace("しらたま", "").strip()
        if not text:
            await message.channel.send("はい、何でしょう？ ボイスメッセージで話しかけてもらえると声でお返事しますよ！")
            return

        async with message.channel.typing():
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(None, claude_generate_response, text)

        if not response:
            response = "すみません、うまく処理できませんでした。"

        await play_tts(response, message.channel)


@bot.event
async def on_voice_state_update(member, before, after):
    """ユーザーがボイスチャンネルに参加/退出したとき → Bot自動参加/退出"""
    global voice_client

    if member.bot:
        return

    guild = bot.get_guild(GUILD_ID)
    if not guild:
        return

    vc_channel = None
    for ch in guild.voice_channels:
        if ch.name == VOICE_CHANNEL_NAME:
            vc_channel = ch
            break
    if not vc_channel:
        return

    # ユーザーが「しらたまルーム」に参加した
    if after.channel and after.channel.id == vc_channel.id:
        if not voice_client or not voice_client.is_connected():
            try:
                voice_client = await vc_channel.connect()
                print(f"[Bot] Joined voice channel: {vc_channel.name}", flush=True)
                conversation_history.clear()

                if listen_channel:
                    await listen_channel.send(
                        f"🎧 **しらたま**がボイスチャンネルに参加しました。\n"
                        f"📱 **#general でボイスメッセージを送って**話しかけてください！声でお返事します。"
                    )

                # 入室挨拶
                greeting = "はい、しらたまです。話しかけてください。"
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                    greet_path = f.name
                voicevox_tts_to_file(greeting, greet_path)
                source = FFmpegPCMAudio(greet_path, options="-ar 48000 -ac 2")
                voice_client.play(source, after=lambda e: cleanup_tts(greet_path, e))

                # 挨拶再生完了を待ってから録音開始
                while voice_client and voice_client.is_playing():
                    await asyncio.sleep(0.3)
                await start_recording()

            except Exception as e:
                print(f"[Bot] Failed to join voice: {e}", file=sys.stderr, flush=True)

    # ユーザーが退出した（Bot以外誰もいなくなった）
    if before.channel and before.channel.id == vc_channel.id:
        human_members = [m for m in vc_channel.members if not m.bot]
        if not human_members and voice_client and voice_client.is_connected():
            print(f"[Bot] No humans left, leaving voice channel", flush=True)
            is_recording = False
            try:
                voice_client.stop_recording()
            except Exception:
                pass
            await voice_client.disconnect()
            voice_client = None
            conversation_history.clear()
            if listen_channel:
                await listen_channel.send(f"👋 **しらたま**がボイスチャンネルから退出しました。")


# ── スラッシュコマンド ────────────────────────────

@bot.slash_command(guild_ids=[GUILD_ID], description="しらたまをボイスチャンネルに呼ぶ")
async def join(ctx):
    global voice_client
    if not ctx.author.voice:
        await ctx.respond("ボイスチャンネルに入ってから呼んでください！", ephemeral=True)
        return
    vc_channel = ctx.author.voice.channel
    if voice_client and voice_client.is_connected():
        await voice_client.move_to(vc_channel)
    else:
        voice_client = await vc_channel.connect()
    conversation_history.clear()
    await ctx.respond(f"🎧 「{vc_channel.name}」に参加しました！話しかけてください。")
    await start_recording()


@bot.slash_command(guild_ids=[GUILD_ID], description="しらたまをボイスチャンネルから退出させる")
async def leave(ctx):
    global voice_client
    if voice_client and voice_client.is_connected():
        is_recording = False
        try:
            voice_client.stop_recording()
        except Exception:
            pass
        await voice_client.disconnect()
        voice_client = None
        conversation_history.clear()
        await ctx.respond("👋 退出しました！")
    else:
        await ctx.respond("ボイスチャンネルにいません。", ephemeral=True)


@bot.slash_command(guild_ids=[GUILD_ID], description="テキストをしらたまの声で読み上げ")
async def say(ctx, text: str):
    global voice_client
    if not voice_client or not voice_client.is_connected():
        await ctx.respond("まずボイスチャンネルに参加してください。 `/join` で呼べます。", ephemeral=True)
        return
    await ctx.defer()
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tts_path = f.name
        voicevox_tts_to_file(text, tts_path)
        source = FFmpegPCMAudio(tts_path, options="-ar 48000 -ac 2")
        if voice_client.is_playing():
            voice_client.stop()
        voice_client.play(source, after=lambda e: cleanup_tts(tts_path, e))
        await ctx.respond(f"🗣️ 「{text}」")
    except Exception as e:
        await ctx.respond(f"⚠️ TTSエラー: {e}")


@bot.slash_command(guild_ids=[GUILD_ID], description="会話履歴をリセット")
async def reset(ctx):
    conversation_history.clear()
    await ctx.respond("🔄 会話履歴をリセットしました。")


# ── メイン ────────────────────────────────────────

if __name__ == "__main__":
    token = load_token()
    print("[Bot] Starting voice chat bot (低レイテンシ版: whisper-cpp Metal + Anthropic SDK stream)...", flush=True)
    print(f"[Bot] VOICEVOX: {VOICEVOX_URL}", flush=True)
    print(f"[Bot] Whisper-cpp: {WHISPER_PATH}", flush=True)
    print(f"[Bot] Whisper model: {WHISPER_MODEL_PATH}", flush=True)
    print(f"[Bot] LLM: Anthropic SDK ({ANTHROPIC_MODEL})", flush=True)
    bot.run(token)
