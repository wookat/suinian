-- R3: titles of up to the first 3 URLs in a note, JSON array of {url, title}
ALTER TABLE notes ADD COLUMN url_titles TEXT;
