"""Select vocal phrases near a target duration, retaining the full-section mode."""
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class VocalSection:
    start: int
    end: int
    vocal_start: int
    vocal_end: int
    phrase_count: int
    next_vocal_start: int | None
    fade_start: int | None = None
    boundary_kind: str = 'phrase'


def runs(mask):
    edges = np.diff(np.r_[False, mask, False].astype(np.int8))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


def near_duration_section(mono, sr, energy, hop, target_seconds, anchor_seconds):
    """Prefer a breath near the target; fade at a quiet point if none exists."""
    if not np.isfinite(target_seconds) or target_seconds <= 0:
        raise ValueError('目标时长必须为正数')
    strong = energy[energy > .003]
    active = energy >= max(.003, float(np.percentile(strong, 70)) * .18)
    for a, b in runs(~active):
        if a and b < len(active) and (b-a)*hop/sr < .18:
            active[a:b] = True
    spans = [(a*hop, min(b*hop, len(mono))) for a, b in runs(active) if (b-a)*hop/sr >= .18]
    if not spans:
        raise ValueError('音源中没有足够连续的歌声')
    anchor = len(mono)/sr*.30 if anchor_seconds is None else anchor_seconds
    candidates = []
    for i, (first, _) in enumerate(spans):
        start = max(0, first-round(sr*.18))
        for j in range(i, len(spans)):
            last = spans[j][1]
            next_start = spans[j+1][0] if j+1 < len(spans) else None
            end = min(len(mono), last+round(sr*.8))
            if next_start is not None:
                end = min(end, next_start-round(sr*.08))
            duration = (end-start)/sr+.15
            if abs(duration-target_seconds) <= 3:
                score = abs(duration-target_seconds)+.002*abs(first/sr-anchor)
                candidates.append((score, VocalSection(start,end,first,last,j-i+1,next_start)))
            if duration > target_seconds+3:
                break
    if candidates:
        return min(candidates, key=lambda c: c[0])[1]
    # Dense singing may contain no usable breath near the target. Prefer a quiet
    # point around it and fade the audio, rather than returning a minute-long clip.
    available = [a for a, _ in spans if len(mono)-a >= (target_seconds-.15)*sr]
    first = min(available or [spans[0][0]], key=lambda a: abs(a/sr-anchor))
    start = max(0, first-round(sr*.18))
    desired = min(len(mono), start+round((target_seconds-.15)*sr))
    lo = max(start+1, desired-round(sr*1.5))
    hi = min(len(mono), desired+round(sr*1.5))
    frames = np.arange((lo+hop-1)//hop, hi//hop)
    quiet_score = energy[frames] + .0001*np.abs(frames*hop-desired)/sr
    end = int(frames[np.argmin(quiet_score)]*hop) if len(frames) else desired
    fade_start = max(first, end-round(sr))
    return VocalSection(start,end,first,end,1,None,fade_start,'quiet_fade')


def complete_section(vocals, sr, anchor_seconds=None, minimum_phrases=4, target_seconds=None):
    """Use breaths to identify phrases, and longer rests for stanza boundaries.

    If there is no stanza break, finish a group of complete phrases. A long
    uninterrupted phrase is retained in full rather than cut to a time budget.
    """
    mono = vocals.mean(axis=1) if vocals.ndim == 2 else vocals
    if not len(mono) or not np.isfinite(mono).all():
        raise ValueError("音源没有有效的歌声")
    hop = max(1, round(sr * .02))
    padded = np.pad(mono, (0, (-len(mono)) % hop))
    energy = np.sqrt(np.mean(padded.reshape(-1, hop) ** 2, axis=1) + 1e-12)
    strong = energy[energy > .003]
    if not len(strong):
        raise ValueError("音源中没有清晰歌声")
    if target_seconds is not None:
        return near_duration_section(mono, sr, energy, hop, float(target_seconds), anchor_seconds)
    threshold = max(.003, float(np.percentile(strong, 70)) * .10)
    active = energy >= threshold
    # Join short consonants/within-word gaps; discard isolated separation noise.
    for a, b in runs(~active):
        if a and b < len(active) and (b-a) * hop / sr < .30:
            active[a:b] = True
    islands = [(a*hop, min(b*hop, len(mono))) for a, b in runs(active)
               if (b-a)*hop/sr >= .18]
    if not islands:
        raise ValueError("音源中没有足够连续的歌声")
    phrases = []
    for a, b in islands:
        if phrases and (a-phrases[-1][1])/sr < .65:
            phrases[-1][1] = b
        else:
            phrases.append([a, b])
    anchor = (len(mono)/sr * .30 if anchor_seconds is None else anchor_seconds) * sr
    nearest = min(range(len(phrases)), key=lambda i: abs(phrases[i][0]-anchor))
    breaks = [i for i in range(1, len(phrases))
              if (phrases[i][0]-phrases[i-1][1])/sr >= 1.6]
    # Start at the beginning of the nearest stanza when its boundary is known.
    previous_breaks = [i for i in breaks if i <= nearest]
    start_index = previous_breaks[-1] if previous_breaks else nearest
    last_index = min(len(phrases)-1, start_index+minimum_phrases-1)
    stanza_ends = [i-1 for i in breaks if i-1 >= last_index]
    if stanza_ends:
        last_index = stanza_ends[0]
    first = phrases[start_index][0]
    last = phrases[last_index][1]
    next_start = phrases[last_index+1][0] if last_index+1 < len(phrases) else None
    end = min(len(mono), last+round(sr*1.2))
    if next_start is not None:
        end = min(end, next_start-round(sr*.10))
    return VocalSection(max(0, first-round(sr*.18)), end, first, last,
                        last_index-start_index+1, next_start)


def mix_section(converted, backing, sr, section):
    """Preserve generated samples and apply the selected natural or quiet release."""
    if converted.ndim == 2:
        converted = converted[:, 0]
    if backing.ndim == 1:
        backing = backing[:, None]
    expected = section.end-section.start
    if abs(len(converted)-expected) > max(sr*.5, expected*.03):
        raise ValueError("生成音频与完整乐段的时长不一致")
    count = max(len(converted), expected)
    converted = np.pad(converted, (0, count-len(converted)))
    backing = np.pad(backing, ((0, max(0, count-len(backing))), (0, 0)))[:count]
    if not np.isfinite(converted).all() or not np.isfinite(backing).all():
        raise ValueError("生成音频包含无效数值")
    voice_rms = float(np.sqrt(np.mean(converted**2)))
    if voice_rms < .001:
        raise ValueError("模型输出接近静音")
    mix = (converted * min(4, .12/voice_rms))[:, None] + .5*backing
    peak = float(np.max(np.abs(mix)))
    mix *= min(1, .93/max(peak, 1e-6))
    attack = min(round(sr*.06), max(0, section.vocal_start-section.start))
    if attack:
        mix[:attack] *= np.linspace(0, 1, attack, dtype=np.float32)[:, None]
    # Phrase selections release after the last note; dense selections use a fade.
    release = min(round(sr*1.2), max(0, count-(section.vocal_end-section.start)))
    if section.fade_start is not None:
        release = max(0, count-(section.fade_start-section.start))
    if release:
        mix[-release:] *= np.linspace(1, 0, release, dtype=np.float32)[:, None]
    return np.pad(mix, ((0, round(sr*.15)), (0, 0)))
