import unittest

import numpy as np

from vocal_tone import smooth_vocal


class VocalToneTests(unittest.TestCase):
    def test_filter_reduces_rumble_and_high_band_preserving_voice_timing(self):
        sr = 44100
        t = np.arange(sr * 2) / sr
        signal = sum(.1 * np.sin(2 * np.pi * hz * t) for hz in (20, 1000, 12000))
        filtered = smooth_vocal(signal, sr, 70, 8000)
        self.assertEqual(filtered.shape, signal.shape)
        self.assertTrue(np.isfinite(filtered).all())
        # Ignore filter edge transients and measure each test tone separately.
        window = slice(sr // 4, -sr // 4)
        for hz, minimum, maximum in ((20, 0, .02), (1000, .95, 1.05), (12000, 0, .1)):
            phasor = np.exp(-2j * np.pi * hz * t[window])
            original = np.mean(signal[window] * phasor)
            result = np.mean(filtered[window] * phasor)
            gain = abs(result / original)
            self.assertGreaterEqual(gain, minimum)
            self.assertLess(gain, maximum)
            if hz == 1000:
                self.assertLess(abs(np.angle(result / original)), .001)

    def test_missing_filter_settings_preserve_existing_audio(self):
        signal = np.linspace(-.2, .2, 1000, dtype=np.float32)
        np.testing.assert_array_equal(smooth_vocal(signal, 44100), signal)

    def test_invalid_audio_and_filter_frequencies_fail_clearly(self):
        for signal, high, low in ((np.array([np.nan]), 70, 8000),
                                  (np.zeros((100, 2)), 70, 8000),
                                  (np.zeros(100), 8000, 70),
                                  (np.zeros(100), 70, 22050)):
            with self.assertRaises(ValueError):
                smooth_vocal(signal, 44100, high, low)


if __name__ == '__main__':
    unittest.main()
