"""Gentle, zero-phase vocal filtering used by the approved D voice preview."""
import numpy as np
from scipy.signal import butter, sosfiltfilt


def smooth_vocal(samples, sample_rate, highpass_hz=0, lowpass_hz=0):
    """Filter a mono vocal without shifting its timing or changing its length."""
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim != 1 or not len(samples) or not np.isfinite(samples).all():
        raise ValueError('Vocal samples must be finite, nonempty mono audio')
    highpass_hz, lowpass_hz = float(highpass_hz), float(lowpass_hz)
    if not all(np.isfinite(v) and 0 <= v < sample_rate / 2
               for v in (highpass_hz, lowpass_hz)):
        raise ValueError('Vocal filter frequencies must be below Nyquist')
    if highpass_hz and lowpass_hz and highpass_hz >= lowpass_hz:
        raise ValueError('Highpass frequency must be below lowpass frequency')
    filters = []
    for frequency, kind in ((highpass_hz, 'highpass'), (lowpass_hz, 'lowpass')):
        if frequency:
            filters.append(butter(2, frequency, btype=kind, fs=sample_rate, output='sos'))
    if not filters:
        return samples
    return sosfiltfilt(np.concatenate(filters), samples).astype(np.float32)
