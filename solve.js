// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly what csv-reader's
// readCsv returns for {text, header} — {columns, rows, errors} — but without the
// reference's one-character-at-a-time loop.
//
// Speed comes from letting V8's native string search do the scanning: an unquoted
// field is found with two indexOf calls (comma / LF) plus one slice, so a whole
// field is taken in a single step instead of a character at a time; a quoted field
// is found with indexOf('"') per quote. Stray CRs, line breaks inside quotes and
// doubled quotes are handled on slow paths that only run when they occur, which
// on the drawn sets is a small fraction of fields. Field strings are slices of
// the input (shared, not copied) until JSON output flattens them.
//
// Semantics (csv-reader 1.0.0, as the kit's RULES.txt states them):
// - U+FEFF at the very start is dropped; a record ends at LF or CRLF; a line left
//   with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled ("" is
//   one quote); CRLF and lone CR inside it read as LF; what follows the closing
//   quote up to the next comma or line break is appended as it stands (quote_junk
//   when the field ends); a quote that never closes is a literal character and the
//   text after it is read again as unquoted (unterminated_quote).
// - A quote inside an unquoted field is a literal character. Fields stay strings.
// - columns is the first record when header is true, else null; rows are padded
//   with "" (short_row, with fields: its count) or cut (long_row, with extra: the
//   cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met; line is the 1-based line
//   its record starts on, counting every LF, CRLF and lone CR inside quotes, and
//   row is its record's index in rows (null for the header).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a U+FEFF at the very start is dropped
  let line = 1; // the line the next character to read is on
  let recordLine = 1; // the line the record being read starts on
  let recordRow = null; // its index in rows (null: the header)

  // The field just read: its value, how it ended and how many characters the
  // unquoted read kept. The readers write these instead of returning an object
  // per field, so a set's million fields cost no result object each.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Appends text[a..b) — one stretch inside a quoted field — to value, counting
  // its line breaks (each LF one, each lone CR one, a CRLF pair one) and reading
  // each CRLF or lone CR inside it as LF. The common stretch holds neither, so
  // this is a single slice with no scan of its own.
  function appendQuoted(value, a, b) {
    if (a >= b) return value;
    const seg = text.slice(a, b);
    if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
      return value === '' ? seg : value + seg;
    }
    let count = 0;
    let i = -1;
    while ((i = seg.indexOf('\n', i + 1)) !== -1) count += 1;
    i = -1;
    while ((i = seg.indexOf('\r', i + 1)) !== -1) {
      if (seg.charCodeAt(i + 1) !== 10) count += 1; // a lone CR; a CRLF pair is its LF
    }
    line += count;
    if (seg.indexOf('\r') === -1) return value === '' ? seg : value + seg;
    const norm = seg.replace(/\r\n?/g, '\n');
    return value === '' ? norm : value + norm;
  }

  // Reads unquoted characters onto `init` up to the next comma or line break: a
  // CR not followed by LF is dropped (stray_cr). It writes the field to fValue,
  // how it ended to fEnded and how many characters were kept to fAdded (`fAdded`
  // counts only this call's keeps, so a caller can tell junk from nothing). The
  // field's end is the nearer of the next comma and the next LF, found natively;
  // a CR can only sit inside that stretch, so it is looked for there and nowhere else.
  function readUnquoted(init, startPos) {
    let value = init;
    let added = 0;
    const ci = text.indexOf(',', startPos);
    const ni = text.indexOf('\n', startPos);
    let end;
    let ended;
    if (ci === -1) {
      if (ni === -1) {
        end = n;
        ended = END;
      } else {
        end = ni;
        ended = LINE_BREAK;
      }
    } else if (ni === -1 || ci < ni) {
      end = ci;
      ended = COMMA;
    } else {
      end = ni;
      ended = LINE_BREAK;
    }
    if (end > startPos) {
      const seg = text.slice(startPos, end);
      if (seg.indexOf('\r') === -1) {
        value = value === '' ? seg : value + seg;
        added = seg.length;
      } else {
        // A CR sits in the stretch: each one is a stray_cr unless it is the CR
        // of the CRLF this field ends at (its last character, ending at a LF).
        let kept = '';
        let from = 0;
        let r = -1;
        while ((r = seg.indexOf('\r', r + 1)) !== -1) {
          const isCrlfTail = r === seg.length - 1 && ended === LINE_BREAK;
          if (!isCrlfTail) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          kept += seg.slice(from, r);
          from = r + 1;
        }
        kept += seg.slice(from);
        if (kept !== '') value = value === '' ? kept : value + kept;
        added = kept.length;
      }
    }
    fValue = value;
    fAdded = added;
    if (ended === COMMA) {
      pos = end + 1;
      fEnded = COMMA;
      return;
    }
    if (ended === LINE_BREAK) {
      pos = end + 1;
      line += 1;
      fEnded = LINE_BREAK;
      return;
    }
    pos = end;
    fEnded = END;
  }

  // Reads a quoted field whose opening quote is at pos, writing it to fValue /
  // fEnded / fAdded as readUnquoted does (fAdded is 0 unless junk follows the
  // closing quote, when it is the junk read's kept count).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let segStart = pos + 1;
    let p = segStart;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"', open + 1);
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        value = appendQuoted(value, segStart, q);
        value += '"';
        p = q + 2;
        segStart = p;
        continue;
      }
      value = appendQuoted(value, segStart, q);
      pos = q + 1;
      if (pos >= n) {
        fValue = value;
        fEnded = END;
        fAdded = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next
      // comma or line break.
      readUnquoted(value, pos);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields;
    let quoted = false;
    // Fast path: a whole record with no quote and no CR (or only the CR of its
    // CRLF ending) is plain unquoted fields — split it natively in one step.
    // A quote anywhere, or a CR anywhere but the CRLF tail, takes the slow path
    // below, which is the exact reader. The line is sliced first so every
    // search in it is bounded by the line, never by the rest of the text.
    const le = text.indexOf('\n', pos);
    const segEnd = le === -1 ? n : le;
    // A record opening with a quote needs the slow path at once; the rest get
    // the fast-path attempt below.
    const lineStr = text.charCodeAt(pos) === 34 ? '' : text.slice(pos, segEnd);
    if (lineStr !== '' && lineStr.indexOf('"') === -1) {
      const ri = lineStr.indexOf('\r');
      if (ri === -1) {
        fields = lineStr.split(',');
      } else if (le !== -1 && ri === lineStr.length - 1) {
        fields = lineStr.slice(0, -1).split(','); // the CR of a CRLF ending
      }
    }
    if (fields !== undefined) {
      pos = le === -1 ? n : le + 1;
      if (le !== -1) line += 1;
      fEnded = END; // the record is complete; the loop below reads none of it
    } else {
      fields = [];
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) readQuoted();
        else readUnquoted('', pos);
        fields.push(fValue);
      } while (fEnded === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its
    // stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
