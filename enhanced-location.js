/* ======================================================================
 * ODIYA — Enhanced Location Description (dispatcher-friendly)
 * -------------------------------------------------------------------------
 * Goal: turn raw GPS coordinates + reverse-geocoded street addresses into
 * natural-language descriptions a 911 dispatcher can understand over the
 * phone, even on highways or when GPS accuracy is poor.
 *
 * Usage:
 *   <script src="enhanced-location.js" defer></script>
 *
 *   // Then from your existing code:
 *   const text = await OdiyaLocation.describe({
 *     position,            // GeolocationPosition
 *     nominatim,           // existing reverse-geocode JSON (optional)
 *     lang: 'en' | 'ko' | ...
 *   });
 *
 * Depends on:
 *   - Overpass API (https://overpass-api.de) — free, no key required.
 *   - Nominatim (already used by ODIYA) for the base address.
 *
 * All network calls are wrapped in timeouts so a slow Overpass response
 * never blocks the emergency flow; if anything fails we fall back to the
 * plain address/coordinate description.
 * ========================================================================= */

(function (global) {
  'use strict';

  // ---------- config ----------
  const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
  const OVERPASS_TIMEOUT_MS = 4000;           // hard cap for the call
  const OVERPASS_SEARCH_RADIUS_M = 3000;      // 3 km around the user
  const POOR_ACCURACY_M = 100;                // threshold for "low accuracy"
  const HEADING_HISTORY_MAX = 5;              // samples kept for bearing calc

  // ---------- heading history (for direction of travel) ----------
  const headingHistory = [];

  function pushHeadingSample(position) {
    if (!position || !position.coords) return;
    headingHistory.push({
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      heading: position.coords.heading, // may be null on stationary / iOS web
      speed: position.coords.speed,     // m/s or null
      t: position.timestamp || Date.now()
    });
    while (headingHistory.length > HEADING_HISTORY_MAX) headingHistory.shift();
  }

  /** Estimate bearing (deg, 0 = north) from recent samples, else null. */
  function estimateBearing() {
    // Prefer the native heading if we have a recent non-null value.
    for (let i = headingHistory.length - 1; i >= 0; i--) {
      const h = headingHistory[i].heading;
      if (typeof h === 'number' && !isNaN(h)) return h;
    }
    // Fall back to bearing between two oldest-newest distinct points.
    if (headingHistory.length < 2) return null;
    const a = headingHistory[0];
    const b = headingHistory[headingHistory.length - 1];
    if (haversine(a.lat, a.lon, b.lat, b.lon) < 30) return null; // <30m, noise
    return bearing(a.lat, a.lon, b.lat, b.lon);
  }

  function bearingToCardinal(deg) {
    if (deg == null) return null;
    const dirs = ['north', 'northeast', 'east', 'southeast',
                  'south', 'southwest', 'west', 'northwest'];
    return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }

  // ---------- geometry helpers ----------
  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
            * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const φ1 = toRad(lat1), φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2)
            - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function metersToMiles(m) { return m / 1609.344; }
  function metersToKm(m)    { return m / 1000; }

  // ---------- Overpass queries ----------
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then(
        v => { clearTimeout(t); resolve(v); },
        e => { clearTimeout(t); reject(e); }
      );
    });
  }

  async function overpass(query) {
    const res = await withTimeout(
      fetch(OVERPASS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: query
      }),
      OVERPASS_TIMEOUT_MS
    );
    if (!res.ok) throw new Error('overpass http ' + res.status);
    return res.json();
  }

  /**
   * Find the nearest motorway way the user is on, plus nearby motorway
   * junction (exit) nodes. Returns { road, junctions[], road_ref, road_name }
   * or null if none found within radius.
   */
  async function findHighwayContext(lat, lon) {
    const q = `
      [out:json][timeout:3];
      (
        way(around:${OVERPASS_SEARCH_RADIUS_M},${lat},${lon})
          ["highway"~"motorway|trunk|primary"];
        node(around:${OVERPASS_SEARCH_RADIUS_M},${lat},${lon})
          ["highway"="motorway_junction"];
      );
      out tags center;
    `;
    try {
      const data = await overpass(q);
      const ways = (data.elements || []).filter(e => e.type === 'way');
      const junctions = (data.elements || []).filter(
        e => e.type === 'node' && e.tags && e.tags.highway === 'motorway_junction'
      );
      if (!ways.length) return null;

      // Pick the closest way by its `center` (Overpass `out center` provides it).
      let bestWay = null, bestDist = Infinity;
      for (const w of ways) {
        if (!w.center) continue;
        const d = haversine(lat, lon, w.center.lat, w.center.lon);
        if (d < bestDist) { bestDist = d; bestWay = w; }
      }
      if (!bestWay) return null;

      // Collect junctions with distances.
      const enrichedJunctions = junctions
        .map(j => ({
          ref: (j.tags && (j.tags.ref || j.tags.name)) || null,
          name: (j.tags && j.tags.name) || null,
          lat: j.lat, lon: j.lon,
          distance_m: haversine(lat, lon, j.lat, j.lon)
        }))
        .filter(j => j.ref || j.name)
        .sort((a, b) => a.distance_m - b.distance_m);

      const t = bestWay.tags || {};
      return {
        road_ref: t.ref || null,         // e.g. "I 95", "US 101"
        road_name: t.name || null,       // e.g. "New Jersey Turnpike"
        road_type: t.highway || null,    // motorway / trunk / ...
        distance_to_road_m: bestDist,
        junctions: enrichedJunctions.slice(0, 3)
      };
    } catch (e) {
      return null;
    }
  }

  /** Find the nearest notable landmark (for low-accuracy fallback). */
  async function findNearestLandmark(lat, lon) {
    const q = `
      [out:json][timeout:3];
      (
        node(around:500,${lat},${lon})["amenity"~"fuel|hospital|police|fire_station|restaurant|cafe|school"];
        node(around:500,${lat},${lon})["shop"];
        node(around:500,${lat},${lon})["tourism"];
      );
      out tags 10;
    `;
    try {
      const data = await overpass(q);
      const els = (data.elements || [])
        .filter(e => e.tags && (e.tags.name || e.tags.brand))
        .map(e => ({
          name: e.tags.name || e.tags.brand,
          kind: e.tags.amenity || e.tags.shop || e.tags.tourism,
          distance_m: haversine(lat, lon, e.lat, e.lon)
        }))
        .sort((a, b) => a.distance_m - b.distance_m);
      return els[0] || null;
    } catch (e) {
      return null;
    }
  }

  // ---------- language templates ----------
  // Each template takes a context object and returns a plain sentence.
  const TEMPLATES = {
    en: {
      highway(c) {
        const dir = c.bearing_cardinal ? c.bearing_cardinal + 'bound' : '';
        const road = c.road_label;
        const parts = [];
        parts.push(`I'm on ${road}${dir ? ' ' + dir : ''}.`);
        if (c.next_exit) {
          const dist = fmtDistance(c.next_exit.distance_m, 'en');
          parts.push(`About ${dist} before Exit ${c.next_exit.ref || c.next_exit.name}.`);
        } else if (c.prev_exit) {
          const dist = fmtDistance(c.prev_exit.distance_m, 'en');
          parts.push(`About ${dist} past Exit ${c.prev_exit.ref || c.prev_exit.name}.`);
        }
        if (c.city) parts.push(`Near ${c.city}.`);
        return parts.join(' ');
      },
      street(c) {
        const bits = [];
        if (c.house_number && c.road) bits.push(`${c.house_number} ${c.road}`);
        else if (c.road) bits.push(c.road);
        if (c.city) bits.push(c.city);
        if (c.state) bits.push(c.state);
        return `I'm at ${bits.join(', ')}.`;
      },
      lowAccuracy(c) {
        const bits = [];
        if (c.landmark)
          bits.push(`I'm somewhere near ${c.landmark.name}`);
        else if (c.city)
          bits.push(`I'm somewhere in ${c.city}`);
        else
          bits.push(`I'm at approximately ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`);
        bits.push(`My GPS accuracy is about ${Math.round(c.accuracy_m)} meters, so this is approximate.`);
        return bits.join('. ') + '.';
      }
    },
    ko: {
      highway(c) {
        const dirMap = { north: '북쪽', south: '남쪽', east: '동쪽', west: '서쪽',
                         northeast: '북동쪽', northwest: '북서쪽',
                         southeast: '남동쪽', southwest: '남서쪽' };
        const dir = c.bearing_cardinal ? dirMap[c.bearing_cardinal] + '으로 ' : '';
        const road = c.road_label;
        const parts = [`${road}에서 ${dir}이동 중입니다.`];
        if (c.next_exit) {
          const dist = fmtDistance(c.next_exit.distance_m, 'ko');
          parts.push(`${c.next_exit.ref || c.next_exit.name} 출구 약 ${dist} 전입니다.`);
        } else if (c.prev_exit) {
          const dist = fmtDistance(c.prev_exit.distance_m, 'ko');
          parts.push(`${c.prev_exit.ref || c.prev_exit.name} 출구에서 약 ${dist} 지났습니다.`);
        }
        if (c.city) parts.push(`${c.city} 근처입니다.`);
        return parts.join(' ');
      },
      street(c) {
        const bits = [];
        if (c.road) bits.push(c.house_number ? `${c.road} ${c.house_number}` : c.road);
        if (c.city) bits.push(c.city);
        if (c.state) bits.push(c.state);
        return `${bits.join(', ')}에 있습니다.`;
      },
      lowAccuracy(c) {
        const parts = [];
        if (c.landmark) parts.push(`${c.landmark.name} 근처에 있습니다`);
        else if (c.city) parts.push(`${c.city} 어딘가에 있습니다`);
        else parts.push(`대략 ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)} 위치입니다`);
        parts.push(`GPS 오차가 약 ${Math.round(c.accuracy_m)}미터라 정확하지 않습니다.`);
        return parts.join('. ') + '.';
      }
    },
    es: {
      highway(c) {
        const dirMap = { north: 'dirección norte', south: 'dirección sur',
                         east: 'dirección este', west: 'dirección oeste',
                         northeast: 'dirección noreste', northwest: 'dirección noroeste',
                         southeast: 'dirección sureste', southwest: 'dirección suroeste' };
        const dir = c.bearing_cardinal ? ' ' + dirMap[c.bearing_cardinal] : '';
        const parts = [`Estoy en ${c.road_label}${dir}.`];
        if (c.next_exit) {
          const dist = fmtDistance(c.next_exit.distance_m, 'es');
          parts.push(`Aproximadamente ${dist} antes de la salida ${c.next_exit.ref || c.next_exit.name}.`);
        }
        if (c.city) parts.push(`Cerca de ${c.city}.`);
        return parts.join(' ');
      },
      street(c) {
        const bits = [];
        if (c.house_number && c.road) bits.push(`${c.road} ${c.house_number}`);
        else if (c.road) bits.push(c.road);
        if (c.city) bits.push(c.city);
        return `Estoy en ${bits.join(', ')}.`;
      },
      lowAccuracy(c) {
        const landmark = c.landmark ? `cerca de ${c.landmark.name}` :
                         (c.city ? `en algún lugar de ${c.city}` :
                          `aproximadamente en ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`);
        return `Estoy ${landmark}. Mi GPS tiene una precisión de unos ${Math.round(c.accuracy_m)} metros, así que es aproximado.`;
      }
    }
  };

  function fmtDistance(m, lang) {
    if (lang === 'en') {
      const mi = metersToMiles(m);
      if (mi >= 0.2) return mi.toFixed(1) + ' miles';
      return Math.round(m * 3.281) + ' feet';
    }
    // metric default
    if (m >= 1000) return (m / 1000).toFixed(1) + (lang === 'ko' ? '킬로미터' : ' km');
    return Math.round(m) + (lang === 'ko' ? '미터' : ' m');
  }

  function pickTemplate(lang) {
    return TEMPLATES[lang] || TEMPLATES.en;
  }

  // ---------- main entrypoint ----------
  /**
   * Build a dispatcher-friendly description string.
   * Never throws; on any failure falls back to the street template.
   *
   * @param {object} opts
   * @param {GeolocationPosition} opts.position
   * @param {object} [opts.nominatim]   existing reverse-geocode JSON
   * @param {string} [opts.lang='en']
   * @returns {Promise<string>}
   */
  async function describe(opts) {
    const { position, nominatim, lang = 'en' } = opts;
    if (!position || !position.coords) return '';

    pushHeadingSample(position);
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const accuracy = position.coords.accuracy || 0;
    const addr = (nominatim && nominatim.address) || {};
    const T = pickTemplate(lang);

    // --- Case A: accuracy is poor -> low-accuracy fallback w/ landmark ---
    if (accuracy > POOR_ACCURACY_M) {
      const landmark = await findNearestLandmark(lat, lon);
      return T.lowAccuracy({
        lat, lon,
        accuracy_m: accuracy,
        city: addr.city || addr.town || addr.village,
        landmark
      });
    }

    // --- Case B: check if we're on a highway ---
    // Heuristic 1: Nominatim tells us directly via `road` starting with
    // "I-", "US-", "Highway", or address.road_type === "motorway".
    const roadFromNominatim = addr.road || '';
    const looksLikeHighway =
      /^(I[-\s]?\d|US[-\s]?\d|Hwy|Highway|Interstate|Motorway|고속도로|Autopista|Autoroute)/i
      .test(roadFromNominatim)
      || (nominatim && nominatim.class === 'highway'
          && /motorway|trunk/i.test(nominatim.type || ''));

    let highwayCtx = null;
    if (looksLikeHighway) {
      highwayCtx = await findHighwayContext(lat, lon);
    }

    if (highwayCtx) {
      // Figure out next/prev exit relative to direction of travel.
      const brg = estimateBearing();
      const cardinal = bearingToCardinal(brg);
      let nextExit = null, prevExit = null;
      if (brg != null && highwayCtx.junctions.length) {
        for (const j of highwayCtx.junctions) {
          const jBrg = bearing(lat, lon, j.lat, j.lon);
          const diff = Math.abs(((jBrg - brg + 540) % 360) - 180);
          if (diff < 90) {
            if (!nextExit || j.distance_m < nextExit.distance_m) nextExit = j;
          } else {
            if (!prevExit || j.distance_m < prevExit.distance_m) prevExit = j;
          }
        }
      } else if (highwayCtx.junctions.length) {
        nextExit = highwayCtx.junctions[0];
      }

      const roadLabel = highwayCtx.road_ref
        ? (highwayCtx.road_name
           ? `${highwayCtx.road_ref} (${highwayCtx.road_name})`
           : highwayCtx.road_ref)
        : (highwayCtx.road_name || roadFromNominatim || 'the highway');

      return T.highway({
        road_label: roadLabel,
        bearing_cardinal: cardinal,
        next_exit: nextExit,
        prev_exit: prevExit,
        city: addr.city || addr.town || addr.village
      });
    }

    // --- Case C: normal street address ---
    return T.street({
      house_number: addr.house_number,
      road: addr.road,
      city: addr.city || addr.town || addr.village,
      state: addr.state
    });
  }


  /** Find nearest named business/landmark with distance and direction. */
  async function findNearbyPOI(lat, lon, lang) {
    const q = `
      [out:json][timeout:5];
      (
        node(around:1000,${lat},${lon})["brand"];
        node(around:800,${lat},${lon})["name"]["amenity"~"fuel|hospital|police|fire_station|school|bank|pharmacy|car_rental"];
        node(around:800,${lat},${lon})["name"]["shop"~"car|supermarket|mall|department_store|car_repair|car_parts"];
        node(around:600,${lat},${lon})["name"]["amenity"~"restaurant|cafe|fast_food"];
        way(around:1000,${lat},${lon})["brand"];
        way(around:800,${lat},${lon})["name"]["amenity"~"fuel|hospital|police|fire_station|school|bank|pharmacy|car_rental"];
        way(around:800,${lat},${lon})["name"]["shop"~"car|supermarket|mall|department_store|car_repair|car_parts"];
      );
      out center body 15;
    `;
    try {
      const data = await withTimeout(overpass(q), OVERPASS_TIMEOUT_MS);
      if (!data || !data.elements || data.elements.length === 0) return null;
      
      // Score each POI: prefer branded, notable, closer
      const scored = [];
      for (const e of data.elements) {
        const eLat = e.lat || (e.center && e.center.lat);
        const eLon = e.lon || (e.center && e.center.lon);
        if (!eLat || !eLon || !e.tags) continue;
        const name = e.tags.brand || e.tags.name;
        if (!name) continue;
        const d = haversine(lat, lon, eLat, eLon);
        
        // Scoring: lower = better
        let score = d; // base: distance in meters
        
        // Brand bonus: branded places are more recognizable (-300m advantage)
        if (e.tags.brand) score -= 300;
        
        // Type bonus for highly visible landmarks
        const amenity = e.tags.amenity || '';
        const shop = e.tags.shop || '';
        if (amenity === 'hospital' || amenity === 'police' || amenity === 'fire_station') score -= 400;
        else if (amenity === 'school' || amenity === 'fuel') score -= 200;
        else if (shop === 'car' || shop === 'supermarket' || shop === 'mall' || shop === 'department_store') score -= 250;
        else if (amenity === 'bank' || amenity === 'pharmacy') score -= 100;
        
        scored.push({
          name: name,
          kind: amenity || shop || e.tags.tourism || e.tags.leisure || null,
          distance_m: d,
          lat: eLat,
          lon: eLon,
          score: score
        });
      }
      
      if (scored.length === 0) return null;
      scored.sort((a, b) => a.score - b.score);
      const best = scored[0];
      
      const dir = bearingToCardinal(bearing(lat, lon, best.lat, best.lon));
      const dist = fmtDistance(best.distance_m, lang || 'en');
      best.direction = dir;
      best.distText = dist;
      return best;
    } catch (e) {
      return null;
    }
  }

  // ---------- public API ----------
  global.OdiyaLocation = {
    describe,
    findNearbyPOI,
    // exposed for testing / reuse:
    _internal: {
      findHighwayContext,
      findNearestLandmark,
      estimateBearing,
      pushHeadingSample,
      bearing,
      haversine
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
