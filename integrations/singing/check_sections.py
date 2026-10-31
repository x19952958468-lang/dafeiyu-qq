import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import numpy as np
from phrase_segments import complete_section,mix_section

class SectionTests(unittest.TestCase):
 def test_variable_four_complete_phrases(self):
  sr=1000; a=np.zeros(60000,dtype=np.float32)
  spans=[(2,5),(5.9,10.9),(11.8,14.3),(15.2,19.2),(22,27),(28,34)]
  for start,end in spans:a[round(start*sr):round(end*sr)]=.12
  s=complete_section(a,sr,anchor_seconds=2)
  self.assertEqual(s.phrase_count,4)
  self.assertAlmostEqual(s.vocal_end/sr,19.2,places=1)
  self.assertGreater(s.end/sr,19.2)
  self.assertLess(s.end/sr,22)
  self.assertNotEqual((s.end-s.start)/sr,10)
 def test_uninterrupted_long_phrase_is_never_cut(self):
  sr=1000;a=np.zeros(100000,dtype=np.float32);a[2000:95000]=.1
  s=complete_section(a,sr,anchor_seconds=30)
  self.assertEqual(s.vocal_end,95000);self.assertGreater(s.end-s.start,90000)
 def test_short_syllable_gaps_are_not_phrase_boundaries(self):
  sr=1000;a=np.zeros(30000,dtype=np.float32)
  for start in np.arange(2,18,.4):a[round(start*sr):round((start+.3)*sr)]=.1
  s=complete_section(a,sr,anchor_seconds=2)
  self.assertEqual(s.phrase_count,1);self.assertGreater(s.vocal_end/sr,17)
 def test_silence_rejected(self):
  with self.assertRaises(ValueError):complete_section(np.zeros(20000),1000)
 def test_tail_fade_begins_after_singing_and_keeps_generated_tail(self):
  sr=1000;a=np.zeros(30000,dtype=np.float32);a[2000:17000]=.12
  s=complete_section(a,sr,anchor_seconds=2)
  voice=a[s.start:s.end];voice=np.pad(voice,(0,80))
  mixed=mix_section(voice,np.zeros((s.end-s.start,2)),sr,s)
  self.assertAlmostEqual(float(mixed[500,0]),float(mixed[14000,0]),places=6)
  self.assertTrue(np.all(mixed[-150:]==0))
  self.assertEqual(len(mixed),len(voice)+150)
 def test_next_phrase_is_not_caught_by_postroll(self):
  sr=1000;a=np.zeros(60000,dtype=np.float32)
  for start,end in [(1,3),(3.8,6),(6.8,9),(9.8,12),(12.8,15)]:a[int(start*sr):int(end*sr)]=.1
  s=complete_section(a,sr,anchor_seconds=1)
  self.assertLess(s.end,s.next_vocal_start)

 def test_twenty_second_target_prefers_a_natural_pause(self):
  sr=1000;a=np.zeros(60000,dtype=np.float32)
  for start,end in [(1,4),(5,9),(10,14),(15,19.8),(23,28),(30,35)]:a[int(start*sr):int(end*sr)]=.1
  s=complete_section(a,sr,anchor_seconds=1,target_seconds=20)
  self.assertAlmostEqual((s.end-s.start)/sr+.15,20,delta=.6)
  self.assertEqual(s.boundary_kind,'phrase');self.assertIsNone(s.fade_start)
  self.assertLess(s.end,s.next_vocal_start)

 def test_twenty_second_target_does_not_return_an_unbroken_ninety_second_phrase(self):
  sr=1000;a=np.zeros(100000,dtype=np.float32);a[2000:95000]=.1
  s=complete_section(a,sr,anchor_seconds=30,target_seconds=20)
  self.assertAlmostEqual((s.end-s.start)/sr+.15,20,delta=.1)
  self.assertEqual(s.boundary_kind,'quiet_fade');self.assertIsNotNone(s.fade_start)
  mixed=mix_section(a[s.start:s.end],np.zeros((s.end-s.start,2)),sr,s)
  self.assertTrue(np.all(mixed[-150:]==0))
  self.assertLess(abs(mixed[-151,0]),abs(mixed[1000,0])*.01)

 def test_target_duration_must_be_positive(self):
  for duration in [0,-20,float('nan')]:
   with self.assertRaises(ValueError):complete_section(np.ones(10000,dtype=np.float32)*.1,1000,target_seconds=duration)

unittest.main()
