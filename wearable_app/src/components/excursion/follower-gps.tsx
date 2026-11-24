import { bearingDegrees, cardinalLabel, guideCue, haversineMeters, relativeBearing } from "@/lib/geo";

type Position = { fix: boolean | null; lat: number | null; lon: number | null };

export function FollowerGps({ leader, follower, heading }: {
  leader: Position;
  follower: Position;
  heading: number | null;
}) {
  if (!follower.fix || follower.lat == null || follower.lon == null) {
    return <p className="mt-3 border-t border-neutral-200 pt-3 text-sm text-neutral-600">Waiting for this board’s GPS fix.</p>;
  }

  const position = (
    <p className="text-xs tabular-nums text-neutral-600">
      Last reported position {follower.lat.toFixed(5)}, {follower.lon.toFixed(5)}
    </p>
  );
  if (!leader.fix || leader.lat == null || leader.lon == null) {
    return (
      <div className="mt-3 border-t border-neutral-200 pt-3">
        <p className="text-sm text-neutral-600">Waiting for the leader board’s GPS fix.</p>
        {position}
      </div>
    );
  }

  const meters = haversineMeters(leader.lat, leader.lon, follower.lat, follower.lon);
  const bearing = bearingDegrees(leader.lat, leader.lon, follower.lat, follower.lon);
  const arrow = heading == null ? bearing : relativeBearing(bearing, heading);
  const distance = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;

  return (
    <div className="mt-3 flex items-center gap-4 border-t border-neutral-200 pt-3">
      {meters >= 1 && (
        <div aria-hidden="true" className="grid size-14 shrink-0 place-items-center rounded-full border border-neutral-300">
          <span className="text-3xl leading-none text-teal-800" style={{ transform: `rotate(${arrow}deg)` }}>↑</span>
        </div>
      )}
      <div>
        <p className="text-sm font-semibold">
          {meters < 1 ? "Same reported location" : `${distance} · ${cardinalLabel(bearing)}`}
        </p>
        {meters >= 1 && (
          <p className="text-sm text-neutral-600">{heading == null ? "North is up" : guideCue(arrow)}</p>
        )}
        {position}
      </div>
    </div>
  );
}
