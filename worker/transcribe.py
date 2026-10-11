"""Melody and chord transcription of one recording with SheetSage2, loaded the same way YuE2-Turbo
loads it for a cover (yue2.cover.MelodyTranscriber), but on its own so the score can be edited
before anything is generated.

The score keeps the song's chords ("Am7" symbols over the Vocal line): an eser tasarımı can send
them with cot=full so YuE2's accompaniment follows the song's harmony, or leave them out (cot=melody)
and let YuE2 make its own. When the chord transcription fails, the melody alone is transcribed, as
YuE2-Turbo does for a cover.

Runs with YuE2-Turbo's venv python (it has SheetSage2's code and transformers):
    /opt/yue/turbo/.venv/bin/python transcribe.py <audio> <out.abc>
"""
import sys

from yue2.cover import MELODY_PROMPTS, MelodyTranscriber, require_melody_abc

# SheetSage2's full task (its skill's `--task full`): timing, meter, structure and key, then the
# chords, then the melody.
FULL_PROMPTS = [p for p in MELODY_PROMPTS if p != "melody_full"] + ["chord_full", "melody_full"]


def with_chords(transcriber, audio):
    model = transcriber.load()
    device = transcriber._torch_device.type if transcriber._torch_device is not None else "cpu"
    result = model.transcribe(str(audio), prompts=FULL_PROMPTS, dtype="bf16" if device == "cuda" else "fp32")
    return require_melody_abc(result)


def main():
    audio, out = sys.argv[1], sys.argv[2]
    # auto: the GPU when it has room (the agent stops YuE2 first), else the CPU. Same model, revision
    # and settings as YuE2-Turbo's own cover transcription (worker/turbo.env).
    transcriber = MelodyTranscriber("m-a-p/SheetSage2", device="auto", min_free_gib=5)
    try:
        abc = with_chords(transcriber, audio)
    except Exception as error:   # the melody alone is still worth having
        print(f"chord transcription failed, transcribing the melody alone: {error}", file=sys.stderr)
        abc = transcriber.transcribe(audio)
    with open(out, "w", encoding="utf-8") as handle:
        handle.write(abc)


if __name__ == "__main__":
    main()
