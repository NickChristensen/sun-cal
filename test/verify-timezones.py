"""Independent parsing of complete local Worker feeds exported by npm test.

Usage: python test/verify-timezones.py <SUN_CAL_TIMEZONE_FIXTURES directory>
"""
import json
import sys
import zoneinfo
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from icalendar import Calendar
import vobject

assert version("icalendar") == "7.3.0"
assert version("vobject") == "0.9.9"
assert version("tzdata") == "2026.5"
zoneinfo.reset_tzpath(())  # pinned tzdata wheel instead of the host database
zoneinfo.ZoneInfo.clear_cache()
directory = Path(sys.argv[1])
manifest = json.loads((directory / "manifest.json").read_text())
checked = 0

def utc(value):
    assert isinstance(value, datetime), "all endpoints are timed, not all-day"
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

for item in manifest:
    body = (directory / (item["uid"] + ".ics")).read_text()
    parsed = Calendar.from_ical(body)
    components = parsed.walk("VTIMEZONE")
    assert len(components) == 1
    embedded = components[0].to_tz(lookup_tzid=False)
    events = {str(event["UID"]): event for event in parsed.walk("VEVENT")}
    other = vobject.readOne(body)
    others = {event.uid.value: event for event in other.vevent_list}
    expected = item["expected"]
    assert len(events) == len(others) == len(expected)
    for event in expected:
        first = events[event["uid"]]
        second = others[event["uid"]]
        assert first.decoded("DTSTAMP").utcoffset().total_seconds() == 0
        for name, instant in [("dtstart", event["start"]), ("dtend", event["end"])]:
            value = first.decoded(name.upper())
            assert utc(value) == instant, (item["uid"], event["uid"], name, "ZoneInfo")
            assert utc(getattr(second, name).value) == instant, (item["uid"], event["uid"], name, "vobject embedded")
            # The extra embedded path shares dateutil with vobject; ZoneInfo
            # above supplies an independent timezone engine. RFC chooses fold 0.
            if first[name].params.get("TZID"):
                value = value.replace(tzinfo=None).replace(tzinfo=embedded, fold=0)
            assert utc(value) == instant, (item["uid"], event["uid"], name, "icalendar embedded")
        checked += 1
print(json.dumps({"feeds": len(manifest), "eventsPerParser": checked,
                  "parsers": ["icalendar 7.3.0 / ZoneInfo 2026e", "vobject 0.9.9 / embedded dateutil"],
                  "extraCheck": "icalendar embedded definition", "failures": 0}, indent=2))
