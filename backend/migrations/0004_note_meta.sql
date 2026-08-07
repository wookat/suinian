-- R12: note metadata JSON ({raw_transcript, image_description})
ALTER TABLE notes ADD COLUMN meta TEXT;
