"""Parse raw Overpass JSON into convenient structures with world-coordinate geometry."""

from __future__ import annotations

from dataclasses import dataclass, field

from shapely.geometry import LineString
from shapely.ops import linemerge, unary_union

from projection import Projector


@dataclass
class Way:
    id: int
    tags: dict
    node_ids: list[int]
    coords: list[tuple[float, float]] = field(default_factory=list)  # world (x, z)

    @property
    def closed(self) -> bool:
        return len(self.node_ids) > 3 and self.node_ids[0] == self.node_ids[-1]


@dataclass
class Relation:
    id: int
    tags: dict
    members: list[dict]


class OsmData:
    def __init__(self, raw: dict):
        self.nodes_ll: dict[int, tuple[float, float]] = {}
        self.node_tags: dict[int, dict] = {}
        self.ways: dict[int, Way] = {}
        self.relations: dict[int, Relation] = {}
        for e in raw["elements"]:
            t = e["type"]
            if t == "node":
                self.nodes_ll[e["id"]] = (e["lat"], e["lon"])
                if "tags" in e:
                    self.node_tags[e["id"]] = e["tags"]
            elif t == "way":
                self.ways[e["id"]] = Way(e["id"], e.get("tags", {}), e["nodes"])
            elif t == "relation":
                self.relations[e["id"]] = Relation(e["id"], e.get("tags", {}), e.get("members", []))
        self.node_xz: dict[int, tuple[float, float]] = {}

    def project(self, proj: Projector) -> None:
        ids = list(self.nodes_ll)
        lats = [self.nodes_ll[i][0] for i in ids]
        lons = [self.nodes_ll[i][1] for i in ids]
        for i, xz in zip(ids, proj.to_world_many(lats, lons)):
            self.node_xz[i] = xz
        for w in self.ways.values():
            w.coords = [self.node_xz[n] for n in w.node_ids if n in self.node_xz]

    # --- queries -------------------------------------------------------------
    def highway_ways(self, name: str | None = None, ref: str | None = None) -> list[Way]:
        out = []
        for w in self.ways.values():
            t = w.tags
            if "highway" not in t:
                continue
            if name is not None and t.get("name") != name:
                continue
            if ref is not None and ref not in (t.get("ref") or "").split(";"):
                continue
            out.append(w)
        return out

    def street_nodes(self, name: str) -> set[int]:
        s: set[int] = set()
        for w in self.highway_ways(name=name):
            s.update(w.node_ids)
        return s

    def street_lines(self, names: list[str], ref: str | None = None, highway: set[str] | None = None):
        """Merged (Multi)LineString in world XZ for all highway ways with any of `names` (or `ref`)."""
        lines = []
        for w in self.ways.values():
            t = w.tags
            if "highway" not in t or len(w.coords) < 2:
                continue
            if highway is not None and t["highway"] not in highway:
                continue
            if ref is not None:
                if ref not in (t.get("ref") or "").split(";"):
                    continue
            elif t.get("name") not in names:
                continue
            lines.append(LineString(w.coords))
        if not lines:
            return None
        return merge_lines(lines)


def merge_lines(lines):
    """Union + merge line pieces; safe for a single LineString (shapely's linemerge rejects it)."""
    u = unary_union(lines)
    return u if isinstance(u, LineString) else linemerge(u)
