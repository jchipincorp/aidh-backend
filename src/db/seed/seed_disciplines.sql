-- seed_disciplines.sql
-- Matches aidh_marketplace.html and aidh_website.html exactly --
-- 18 disciplines across 3 tiers. Slugs match the existing mp-* card IDs.

INSERT INTO disciplines (slug, name, tier, description) VALUES
  ('functional-nutrition',   'Functional Nutrition',      1, 'Personalised living food protocols, anti-inflammatory plans, microbiome optimisation.'),
  ('ands-nds-naturopath',    'ANDS / NDS Naturopath',     1, 'Root cause medicine, colon clearance, fasting protocols, herbal prescriptions.'),
  ('naturopathy',            'Naturopathy',                1, 'Natural therapies, detox protocols, medical herbalism, nutritional medicine.'),
  ('colon-hydrotherapy',     'Colon Hydrotherapy',        1, 'FACT certified therapists. Direct colon clearance and LPS reduction protocols.'),
  ('fasting-coach',          'Fasting Coach',              1, 'Daily repair window optimisation, OMAD protocols, autophagy maximisation.'),
  ('ayurvedic-practitioner', 'Ayurvedic Practitioner',    1, 'BAMS-qualified. Dosha protocol, Panchakarma, herbal medicine, organ clock alignment.'),
  ('homeopathy',             'Homeopathy',                  1, 'Constitutional homeopathic treatment. Chronic condition support and immune regulation.'),
  ('acupuncture-tcm',        'Acupuncture / TCM',         1, 'Traditional Chinese Medicine. Meridian balancing, organ system support, pain management.'),

  ('yoga-practitioner',      'Yoga Practitioner',          2, 'Yoga Nidra, pranayama, Surya Namaskar, breathwork and sleep medicine protocols.'),
  ('meditation-coach',       'Meditation Coach',           2, 'HPA axis interruption, vagal tone restoration, parasympathetic nervous system support.'),
  ('sleep-medicine-coach',   'Sleep Medicine Coach',      2, 'Circadian rhythm restoration, glymphatic optimisation, melatonin cycle support.'),
  ('breathwork-coach',       'Breathwork Coach',           2, 'Pranayama and breathwork protocols for cortisol reduction and HRV improvement.'),
  ('clinical-psychology',    'Clinical Psychology',       2, 'Evidence-based therapy for chronic stress, anxiety, behavioural change and resilience.'),

  ('pranic-healing',         'Pranic Healing',             3, 'Energy body cleansing and vitalisation. Complementary support for all 5 pillars.'),
  ('reiki',                  'Reiki',                       3, 'Japanese hands-on energy technique for relaxation and stress reduction.'),
  ('integrative-medicine',   'Integrative Medicine Practitioner', 3, 'MD/DO-level physicians, board-certified to blend conventional and complementary approaches.'),
  ('tai-chi-qigong',         'Tai Chi / Qigong',           3, 'Movement-based energy cultivation. Stress reduction, lymphatic flow, circadian support.'),
  ('feng-shui-vastu',        'Feng Shui / Vastu',         3, 'Environmental harmony aligned with circadian biology and organ clock principles.')
ON CONFLICT (slug) DO NOTHING;
