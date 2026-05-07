#!/usr/bin/env python3.13
"""
voice-chat-bot.py — Discord音声やりとりBot

音声入力: テキストチャンネルのボイスメッセージ(.ogg) → whisper文字起こし
応答生成: Claude CLI stream-json（サブスクリプション認証・API課金なし）
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
import threading
import time
import urllib.request
import wave
from collections import deque
from pathlib import Path

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
# 固有名詞を whisper に事前提示して認識精度を上げる（地名・事業名・関係者）
WHISPER_INITIAL_PROMPT = (
    "Ryo、しらたま、ごま、えんがわ、三十日珈琲、SATOYAMA AI BASE、"
    "となりにとまる、任屋、Basecamp Torisawa、星の図書館、テンプレートショップ、"
    "上野原、西原、丹波山、大月、藤野、山梨、空き家、民泊、補助金、"
    "Notion、Discord、Obsidian、Vercel、Stripe"
)

# ── B. Claude CLI（stream-json ストリーミング / サブスクリプション認証）──
CLAUDE_PATH = "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin/claude"
ANTHROPIC_MODEL = "claude-sonnet-4-6"

REPO_DIR = Path(__file__).parent.parent
LOG_DIR = REPO_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)

MAX_CONVERSATION_TURNS = 10
MIN_AUDIO_DURATION_S = 2.0

# STTが空（whisper認識失敗）時に能動的に聞き返すための連発ガード
_last_apology_ts: float = 0.0
APOLOGY_COOLDOWN_S = 30.0  # 30秒以内連発禁止（ノイズ誤発火対策）


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

## 会話の最優先ルール（一番重要）
- **直前のRyo発話とその前のbot応答を最重視**。これが会話の中心
- **会話履歴は順番に踏まえる**。話題が変わったらきちんとついていく
- **メモリ・コンテキスト情報は補助**。Ryoに聞かれたとき・話題に自然に繋がるときだけ使う。聞かれてもいないのに勝手に「今日はこれをやってましたね」と絡めない
- Ryo が「もう話終わり」「次の話」と言ったら即座に切り替える

## ボイスチャットでの応答ルール
- 1〜3文で簡潔に。20秒以内に話せる長さ（150文字以内目安）
- 音声で読み上げるので、箇条書きや記号は使わない。完全な口語体
- 「ですます」調で、親しみやすく
- 質問には直接答える。前置きは不要
- 複雑な話題は「詳しくはテキストで送りますね」と言って短く返す

## 応答品質の原則
- **事実確認できないことは言わない**。占い・スピリチュアル・数秘術など Ryo が扱っていない領域を勝手に絡めない
- **Ryo の事業はメモリ・コンテキストで把握している範囲のみ**。記憶にない事業・活動・人物を作らない（ハルシネーション禁止）
- **「面白い話して」のような曖昧な要望** → 文脈を踏まえて具体テーマを提案するか、Ryo に「どの事業の話か」「最近の話題か」 1点だけ聞き返す
- **聞き取れなかった単語**（「にしらに」「西原」など固有名詞の不明瞭）→ 推測で答えず「すみません、もう一度お願いできますか」と素で返す
- 表面的な相槌で終わらせない。Ryo の発話に対して意味のある反応を返す（同意・追加情報・反論・確認など）

## 利用可能な機能（重要・厳守）
あなたはこのボイスチャットで以下のツールを持っていません:
- Web検索・ブラウザ検索・URL確認（「検索します」「ブラウザで見てみます」と言わない）
- ファイル読み書き・コード実行・スクリーンショット
- 外部API呼び出し・Notion/Discord等への書き込み・読み取り

できるのは対話のみ（プロンプトに渡された情報＋自分の知識で答える）。
Ryo が「Airbnbリスティング見て」「URL確認して」「Notion見て」「最新ニュース調べて」と言われた場合は、
「申し訳ない、ボイスチャットでは確認できないので、内容をテキストで送ってもらえれば話せます」と素直に返す。
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
CEO_DAILY_CONTEXT = Path("/Users/ocmm/agents/ceo/sessions/daily-context.md")
CEO_SESSION_GLOB = "/Users/ocmm/agents/ceo/sessions/current-session-*.md"
OBSIDIAN_DASHBOARD = Path(
    "/Users/ocmm/Library/Mobile Documents/iCloud~md~obsidian"
    "/Documents/obsidian-vault/ダッシュボード.md"
)
DISCORD_GENERAL_ID = "1486651095580282942"

_discord_history_cache: list[str] = []
_discord_history_ts: float = 0.0


def load_ceo_context() -> str:
    """CEOのメモリ・daily-context・Obsidianダッシュボード・最新セッションを読み込む"""
    import glob as _glob

    parts = []

    # 1. CEOメモリインデックス（参考情報）
    try:
        index = CEO_MEMORY_INDEX.read_text()
        parts.append("## CEOメモリ（参考情報）")
        parts.append(index[:1500])
    except Exception:
        pass

    # 2. CEO daily-context（今日の全状況サマリー、先頭1500字に削減）
    try:
        daily = CEO_DAILY_CONTEXT.read_text()
        parts.append("\n## 今日の状況サマリー（daily-context）")
        parts.append(daily[:1500])
    except Exception:
        pass

    # 3. Obsidian ダッシュボード（事業全体像、1000字に削減）
    try:
        dashboard = OBSIDIAN_DASHBOARD.read_text()
        parts.append("\n## Obsidianダッシュボード（事業全体像）")
        parts.append(dashboard[:1000])
    except Exception:
        pass

    # 4. 最新の CEO セッションファイル（末尾1000字に削減）
    try:
        session_files = sorted(_glob.glob(CEO_SESSION_GLOB))
        if session_files:
            latest = Path(session_files[-1]).read_text()
            tail = latest[-1000:] if len(latest) > 1000 else latest
            parts.append("\n## 直近のCEO作業ログ（セッション末尾）")
            parts.append(tail)
    except Exception:
        pass

    # 5. 後方互換: discord migration コンテキスト（あれば）
    try:
        discord_ctx = CEO_DISCORD_CONTEXT.read_text()
        parts.append("\n## 補足コンテキスト")
        parts.append(discord_ctx[:1000])
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
            "User-Agent": "DiscordBot (https://github.com/inaryo1024/voice-chat-bot, 1.0)",
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
    parts.append(
        "\nしらたまとして応答してください。"
        "【最重要】直前のRyo発話と直前のbot応答を最優先で踏まえて返す。"
        "メモリ・コンテキスト情報は補助として使い、話題に関係ないのに勝手に絡めない。"
        "ボイスチャットルールに従い150文字以内・口語体・箇条書きなし。"
        "応答テキストのみ出力し「しらたま:」などのプレフィックスは付けない。"
    )
    return "\n".join(parts)


# Claude CLI 用環境変数（ANTHROPIC_API_KEY を除去してサブスクリプション認証を強制）
CLAUDE_ENV = {
    k: v for k, v in os.environ.items()
    if k not in ("ANTHROPIC_API_KEY", "CLAUDECODE")
}
CLAUDE_ENV["HOME"] = "/Users/ocmm"
CLAUDE_ENV["PATH"] = (
    "/Users/ocmm/.local/share/mise/installs/node/24.14.0/bin"
    ":/Users/ocmm/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
)


class ClaudePersistentClient:
    """Claude CLI を1プロセス常駐させて毎ターン起動コストを排除する。

    初回起動時のみ Node.js cold start（4〜5秒）が発生し、
    2回目以降は stdin に user message JSONL を書き込むだけで
    応答 stream を受け取れる（目標: first_text_token 1〜3秒）。

    排他制御: threading.Lock で同時発話を防ぐ。
    死活監視: _watchdog_thread でプロセス終了・ハングを検知し自動再起動。
    ハングタイムアウト: stdout から HANG_TIMEOUT_S 秒間無応答なら kill して再起動。
    """

    SENTENCE_DELIMITERS = {"。", "！", "？", "!", "?"}

    # ── タイムアウト設定 ─────────────────────────────
    # stdout から何も届かない時間がこれを超えたら「ハング」と判定して kill
    HANG_TIMEOUT_S = 25.0
    # ロック待ちのタイムアウト（前のターンが詰まっても永久待機しない）
    LOCK_WAIT_TIMEOUT_S = 20.0

    def __init__(self):
        self._proc: subprocess.Popen | None = None
        # stream_sentences 全体を排他する（stdout read 中もロック保持）
        self._lock = threading.Lock()
        self._turn_count = 0
        self._watchdog: threading.Thread | None = None
        self._shutdown = False
        # ハング検知: 最後に stdout からデータを受信した時刻
        self._last_stdout_ts: float = time.monotonic()
        # 現在ターンが処理中かどうか（watchdog がハング判定に使う）
        self._in_turn: bool = False

    # ── プロセス管理 ────────────────────────────────

    # MCP 完全無効化用の空設定（cold start 短縮の本丸・2026-05-07）
    # 全 MCP server (Notion/Figma/Canva/Make/Vercel など 15個) を起動毎に立ち上げると
    # cache_creation_input_tokens が 107K → 5.2K (-95%)、TTFT が 3.4s → 1.3s に縮む実測あり。
    # ボイスチャットは外部API使わない（MCP/Web/Bash 全禁止）方針なので機能ロスなし。
    _EMPTY_MCP_CONFIG = "/Users/ocmm/rina/scripts/empty-mcp.json"

    def _build_args(self) -> list[str]:
        return [
            CLAUDE_PATH,
            "-p",
            "--model", ANTHROPIC_MODEL,
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--no-session-persistence",
            "--tools", "",           # built-in（Read/Write/Bash 等）を無効化
            "--strict-mcp-config",   # MCP は --mcp-config 指定のみ使用（=空）
            "--mcp-config", self._EMPTY_MCP_CONFIG,
            "--system-prompt", SHIRATAMA_SYSTEM_PROMPT,
        ]

    def start(self):
        """one-shot 方式では事前 spawn 不要。互換性のため log 出力のみ。"""
        self._shutdown = False
        print("[Claude] One-shot mode (per-turn spawn).", flush=True)

    def stop(self):
        """プロセスを終了する（bot 終了時）。"""
        self._shutdown = True
        with self._lock:
            self._kill()

    # CLAUDE.md auto-discovery 回避用の作業ディレクトリ
    # cwd=REPO_DIR (~/rina) だと ~/rina/CLAUDE.md (26KB) が毎ターン読み込まれる。
    # 専用クリーンディレクトリで起動して読み込みを抑制（コンテキストは build_claude_prompt で渡す）。
    _CLEAN_CWD = "/tmp/voice-chat-bot-cwd"

    def _spawn(self):
        """1ターン分の claude CLI subprocess を生成する。

        2026-05-07: persistent process 方式は stdin 開きっぱなしで詰まる事象があったため、
        毎ターン新規 spawn → write → close stdin (= EOF) → read stdout → exit する one-shot 方式に変更。
        MCP 完全無効化により cold start が 1.4s なので、許容できるレイテンシ（毎ターン 3-4s）。
        """
        self._kill()
        os.makedirs(self._CLEAN_CWD, exist_ok=True)
        self._proc = subprocess.Popen(
            self._build_args(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,  # stderr buffer 満杯ハング回避
            text=True,
            env=CLAUDE_ENV,
            cwd=self._CLEAN_CWD,
            bufsize=1,
        )
        self._last_stdout_ts = time.monotonic()

    def _kill(self):
        """現在のプロセスを強制終了する（_lock 保持中に呼ぶこと）。"""
        if self._proc is not None:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
            try:
                self._proc.kill()
                self._proc.wait(timeout=3)
            except Exception:
                pass
            self._proc = None

    def _watchdog_loop(self):
        """プロセスの死活・ハングを監視し、問題があれば再起動する。

        監視項目:
        1. プロセス終了: poll() != None → 再起動
        2. ハング: ターン処理中かつ stdout 無応答が HANG_TIMEOUT_S 超過 → kill して再起動

        ハング検知時は _lock を force-acquire して再起動する。
        stream_sentences 側は _hung フラグを見て timeout 扱いにする。
        """
        self._hung = False
        while not self._shutdown:
            time.sleep(2)

            now = time.monotonic()

            # ── ハング検知（プロセスが生きているが stdout 無応答）──
            if (
                self._in_turn
                and self._proc is not None
                and self._proc.poll() is None
                and now - self._last_stdout_ts > self.HANG_TIMEOUT_S
            ):
                elapsed = now - self._last_stdout_ts
                print(
                    f"[Claude] HANG detected: no stdout for {elapsed:.1f}s, force-restarting...",
                    flush=True,
                )
                # _hung フラグを立てて stream_sentences 側の読み取りループを脱出させる
                self._hung = True
                try:
                    self._proc.kill()
                except Exception:
                    pass
                # ロックが空くのを最大5秒待ってから再 spawn
                acquired = self._lock.acquire(timeout=5)
                try:
                    self._proc = None
                    self._spawn()
                    self._turn_count = 0
                    self._in_turn = False
                    self._hung = False
                    print(
                        f"[Claude] Restarted after hang (PID: {self._proc.pid})",
                        flush=True,
                    )
                finally:
                    if acquired:
                        self._lock.release()
                continue

            # ── プロセス終了検知 ──────────────────────────────
            if self._lock.acquire(blocking=False):
                try:
                    if self._proc is not None and self._proc.poll() is not None:
                        print(
                            f"[Claude] Process died (rc={self._proc.returncode}), restarting...",
                            flush=True,
                        )
                        self._spawn()
                        self._turn_count = 0
                        print(
                            f"[Claude] Restarted (PID: {self._proc.pid})",
                            flush=True,
                        )
                finally:
                    self._lock.release()

    # ── ストリーミング ───────────────────────────────

    def stream_sentences(self, user_text: str):
        """user_text を送信し、句点単位で応答文を yield する（同期ジェネレータ）。

        呼び出し元は run_in_executor 経由で asyncio から使う。
        排他ロック（threading.Lock）により同時発話は順番待ちになる。

        改善点（v2）:
        - LOCK_WAIT_TIMEOUT_S: ロック取得に時間がかかりすぎる場合はスキップ
        - HANG_TIMEOUT_S: stdout 無応答を watchdog が検知して kill → _hung フラグで脱出
        - result.is_error: エラーイベントを検出してログ出力
        - 異常レイテンシ（>10秒）: 詳細ログを残す
        """
        # ロック取得タイムアウト: 前のターンが詰まっていても永久待機しない
        acquired = self._lock.acquire(timeout=self.LOCK_WAIT_TIMEOUT_S)
        if not acquired:
            print(
                f"[Claude] Lock timeout ({self.LOCK_WAIT_TIMEOUT_S}s): previous turn still running, skipping.",
                flush=True,
            )
            yield "すみません、前の応答がまだ処理中です。少し待ってからもう一度お願いできますか。"
            return

        # ターン全体のハードタイムアウト（cold start + 推論 + 読み取り）
        TURN_HARD_TIMEOUT_S = 45.0

        try:
            self._turn_count += 1
            turn = self._turn_count
            label = f"{turn}回目"

            # 毎ターン新規 spawn (one-shot)。stdin EOF で確実に処理を始めさせる
            self._spawn()
            proc = self._proc

            prompt = build_claude_prompt(user_text)
            msg = json.dumps({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": prompt}],
                },
            })

            buf = ""
            full_response = ""
            first_text_token = True
            t_start = time.monotonic()
            event_count = 0

            # write → close stdin（EOF）で claude CLI に処理開始を促す
            try:
                proc.stdin.write(msg + "\n")
                proc.stdin.flush()
                proc.stdin.close()
            except (BrokenPipeError, OSError) as e:
                print(f"[Claude] stdin write error: {e}", flush=True)
                yield "すみません、応答できませんでした。もう一度お願いできますか。"
                return

            timed_out = False
            try:
                for raw_line in proc.stdout:
                    # ターン全体のハードタイムアウト
                    elapsed_total = time.monotonic() - t_start
                    if elapsed_total > TURN_HARD_TIMEOUT_S:
                        print(
                            f"[Claude] Turn {label} hard timeout: {elapsed_total:.1f}s "
                            f"(events_received={event_count})",
                            flush=True,
                        )
                        timed_out = True
                        break

                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    event_count += 1

                    if ev.get("type") == "result":
                        if ev.get("is_error"):
                            err_msg = ev.get("result", "")
                            print(
                                f"[Claude] ERROR result (turn={label}): {str(err_msg)[:300]}",
                                flush=True,
                            )
                        break

                    if ev.get("type") != "stream_event":
                        continue
                    inner = ev.get("event", {})
                    if inner.get("type") != "content_block_delta":
                        continue
                    delta = inner.get("delta", {})
                    if delta.get("type") != "text_delta":
                        continue
                    chunk = delta.get("text", "")
                    if not chunk:
                        continue

                    if first_text_token:
                        t_first = time.monotonic()
                        elapsed = t_first - t_start
                        if elapsed > 10.0:
                            print(
                                f"[Latency] first_text_token ({label}): {elapsed:.2f}s "
                                f"[SLOW] prompt_tail={repr(user_text[-50:])} "
                                f"first_event={repr(chunk[:40])}",
                                flush=True,
                            )
                        else:
                            print(
                                f"[Latency] first_text_token ({label}): {elapsed:.2f}s",
                                flush=True,
                            )
                        first_text_token = False

                    for ch in chunk:
                        buf += ch
                        if ch in self.SENTENCE_DELIMITERS and len(buf.strip()) > 1:
                            sentence = buf.strip()
                            if sentence:
                                full_response += sentence
                                yield sentence
                            buf = ""

            except Exception as e:
                print(f"[Claude] Stream error: {e}", file=sys.stderr, flush=True)

            if timed_out:
                yield "すみません、応答が詰まりました。もう一度お願いできますか。"

            remainder = buf.strip()
            if remainder:
                full_response += remainder
                yield remainder

            if full_response:
                conversation_history.append({"role": "user", "content": user_text})
                conversation_history.append({"role": "assistant", "content": full_response})

        finally:
            # one-shot: ターン終了時に proc を確実に kill
            if self._proc is not None:
                try:
                    if self._proc.poll() is None:
                        self._proc.kill()
                    self._proc.wait(timeout=3)
                except Exception:
                    pass
                self._proc = None
            self._lock.release()


# ── グローバルクライアント（bot 起動時に初期化）────
_persistent_client: ClaudePersistentClient | None = None


def get_persistent_client() -> ClaudePersistentClient:
    global _persistent_client
    if _persistent_client is None:
        _persistent_client = ClaudePersistentClient()
    return _persistent_client


def claude_generate_response(user_text: str) -> str:
    """同期版: 全応答を一括取得（ボイスメッセージ/Siri用フォールバック）"""
    sentences = list(claude_stream_sentences(user_text))
    full = "".join(sentences)
    return full


def claude_stream_sentences(user_text: str):
    """Claude 永続プロセスで句点ごとに文を yield する"""
    yield from get_persistent_client().stream_sentences(user_text)


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
            "--no-speech-thold", "0.3",
            "--prompt", WHISPER_INITIAL_PROMPT,
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

# ── D. 状態表示UX（Discord Activity / Presence）────
_BOT_STATES = {
    "idle":         "💭 待機中",
    "recording":    "🎙️ 録音中",
    "transcribing": "📝 文字起こし中",
    "thinking":     "🤔 考え中",
    "speaking":     "🔊 話してる",
}


def set_state(state: str) -> None:
    """Botのプレゼンスを更新してRyoに現在状態を表示する。

    state は 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking' のいずれか。
    asyncio イベントループ内から呼ぶこと（coroutine ではなく同期的に task を作成）。
    """
    label = _BOT_STATES.get(state, state)
    try:
        activity = discord.Game(name=label)
        asyncio.get_event_loop().create_task(bot.change_presence(activity=activity))
    except Exception:
        pass  # イベントループ未起動など起動初期は無視


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
        set_state("speaking")
        voice_client.play(source, after=after_play)
        await done.wait()

    tts_playing = False
    set_state("recording" if is_recording else "idle")


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

    set_state("thinking")
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
            set_state("transcribing")
            print(f"[Bot] Transcribing VC audio from user {user_id} ({len(wav_bytes)} bytes, {duration:.1f}s)...", flush=True)
            loop = asyncio.get_event_loop()
            text = await loop.run_in_executor(None, whisper_transcribe, wav_path)
            t1 = time.monotonic()

            if not text or len(text.strip()) < 2:
                # STTが空＝whisperが認識できなかった。一定長の録音なら能動的に聞き返す
                if duration >= 1.5:
                    global _last_apology_ts
                    now = time.monotonic()
                    if now - _last_apology_ts > APOLOGY_COOLDOWN_S:
                        _last_apology_ts = now
                        print(f"[Bot] STT empty for {duration:.1f}s audio, asking Ryo to repeat", flush=True)
                        await _enqueue_tts("すみません、聞き取れませんでした。もう一度お願いできますか。")
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
SILENCE_TIMEOUT_S = 1.8  # 無音でこの秒数経過したら録音停止（「うん」と次の発話の自然な間を許容）
last_speaking_time: float = 0.0  # 最後に誰かが喋った時刻


async def start_recording():
    """ボイスチャンネルの録音を開始。無音検知 or 最大時間で区切る"""
    global voice_client, is_recording, current_sink, last_speaking_time

    if not voice_client or is_recording:
        return

    is_recording = True
    set_state("recording")
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
            # VAD: 累積バイト数の差分で発話検知（前回比で増えていれば喋っている）
            elapsed = 0.0
            prev_total = 0
            while elapsed < RECORD_MAX_S and is_recording:
                await asyncio.sleep(0.2)
                elapsed += 0.2
                now = asyncio.get_event_loop().time()

                # sink の累積データサイズを取得
                total = 0
                if current_sink and current_sink.audio_data:
                    total = sum(len(a.file.getvalue()) for a in current_sink.audio_data.values())

                # データが増えている = Ryoが喋っている
                # py-cord の Sink は user_id 単位で音声を保持し Bot 自身の出力は入らないため
                # ループバック誤発火の心配なく TTS 再生中も発話検知できる
                if total > prev_total:
                    last_speaking_time = now
                    # バージイン: TTS再生中にRyoが話し始めたら即座に中断
                    if tts_playing:
                        print("[Bot] Barge-in detected: Ryo spoke during TTS playback", flush=True)
                        trigger_barge_in()
                prev_total = total

                # 1秒以上経過 + データあり + 直近の発話から SILENCE_TIMEOUT_S 経過 → 終了
                if total > 0 and elapsed > 1.0:
                    silence = now - last_speaking_time
                    if silence >= SILENCE_TIMEOUT_S:
                        print(f"[Bot] Silence detected ({silence:.1f}s), stopping chunk at {elapsed:.1f}s", flush=True)
                        break

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

    # Claude 永続プロセスを事前起動（初回起動コストをここで消化）
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, get_persistent_client().start)
    print("[Bot] Claude persistent process ready.", flush=True)

    await bot.change_presence(activity=discord.Game(name=_BOT_STATES["idle"]))


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
            set_state("idle")
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
    print("[Bot] Starting voice chat bot (低レイテンシ版: whisper-cpp Metal + Claude CLI stream-json)...", flush=True)
    print(f"[Bot] VOICEVOX: {VOICEVOX_URL}", flush=True)
    print(f"[Bot] Whisper-cpp: {WHISPER_PATH}", flush=True)
    print(f"[Bot] Whisper model: {WHISPER_MODEL_PATH}", flush=True)
    print(f"[Bot] LLM: Claude CLI stream-json ({ANTHROPIC_MODEL})", flush=True)
    bot.run(token)
