"""Disposable GTK application with independent drag/scroll postconditions."""
import json
from pathlib import Path
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

window = Gtk.Window(title="DeskSwarm Driver acceptance")
window.set_default_size(700, 650)
window.move(150, 150)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=15)
box.set_border_width(20)
window.add(box)
entry = Gtk.Entry()
box.pack_start(entry, False, False, 0)
button = Gtk.Button(label="Mouse test: 0")
box.pack_start(button, False, False, 0)
drag_entry = Gtk.Entry()
drag_entry.set_text("DRAG SELECT THIS TEXT")
box.pack_start(drag_entry, False, False, 0)
scroll = Gtk.ScrolledWindow()
scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.ALWAYS)
text = Gtk.TextView()
text.get_buffer().set_text("\n".join(f"Visible row {i:03d}" for i in range(1, 201)))
scroll.add(text)
box.pack_start(scroll, True, True, 0)
state = {"clicks": 0}

def snapshot():
    selection = drag_entry.get_selection_bounds()
    selected = drag_entry.get_text()[selection[0]:selection[1]] if selection else ""
    adjustment = scroll.get_vadjustment()
    result = dict(state, text=entry.get_text(), selected_text=selected,
                  scroll_value=adjustment.get_value(), scroll_upper=adjustment.get_upper(),
                  scroll_page_size=adjustment.get_page_size())
    path = Path("/tmp/deskswarm-acceptance.json")
    pending = path.with_suffix(".pending")
    pending.write_text(json.dumps(result, ensure_ascii=False))
    pending.replace(path)
    return True

def clicked(*_):
    state["clicks"] += 1
    button.set_label(f"Mouse test: {state['clicks']}")
    snapshot()

button.connect("clicked", clicked)
window.connect("destroy", Gtk.main_quit)
window.show_all()
GLib.timeout_add(50, snapshot)
snapshot()
Gtk.main()
