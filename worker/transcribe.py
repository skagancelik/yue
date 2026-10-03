"""Melody transcription of one recording with SheetSage2, the same way YuE2-Turbo does it for a
cover (yue2.cover.MelodyTranscriber: melody only, no chords), but on its own so the score can be
edited before anything is generated.

Runs with YuE2-Turbo's venv python (it has SheetSage2's code and transformers):
    /opt/yue/turbo/.venv/bin/python transcribe.py <audio> <out.abc>
"""
import sys

from yue2.cover import MelodyTranscriber


def main():
    audio, out = sys.argv[1], sys.argv[2]
    # auto: the GPU when it has room (the agent stops YuE2 first), else the CPU. Same model, revision
    # and settings as YuE2-Turbo's own cover transcription (worker/turbo.env).
    transcriber = MelodyTranscriber("m-a-p/SheetSage2", device="auto", min_free_gib=5)
    abc = transcriber.transcribe(audio)
    with open(out, "w", encoding="utf-8") as handle:
        handle.write(abc)


if __name__ == "__main__":
    main()
