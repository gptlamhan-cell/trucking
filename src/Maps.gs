/**
 * Google Maps:
 *   suggestAddresses — gợi ý địa chỉ khi gõ (có dấu / không dấu).
 *       Có MAPS_API_KEY: dùng Places Autocomplete (New), kết quả giống ô tìm kiếm Google Maps.
 *       Không có key:    dùng Geocoder có sẵn của Apps Script (thêm dấu trước khi tra).
 *   resolvePlace     — lấy tọa độ của gợi ý đã chọn.
 *   nearbyRoutes     — tìm tuyến trong bảng cước gần điểm giao nhất theo đường bộ.
 *       Có key: đo tất cả điểm trong 1 lần gọi Routes API (computeRouteMatrix).
 *       Không có key: dùng DirectionFinder, mỗi điểm 1 lần gọi.
 * Mọi kết quả đều được cache để tiết kiệm hạn mức.
 */

const HUB_CENTERS_ = {
  HAN: {lat: 21.0285, lng: 105.8542},
  HPH: {lat: 20.8449, lng: 106.6881},
  HCM: {lat: 10.7769, lng: 106.7009},
};

function parseCoords_(text) {
  const m = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const point = {lat: Number(m[1]), lng: Number(m[2])};
  if (Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) throw Error('Tọa độ không hợp lệ.');
  return point;
}

function directKm_(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function cacheJson_(key, ttl, compute) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit !== null) {
    try { return JSON.parse(hit); } catch (e) { /* tính lại */ }
  }
  const value = compute();
  if (value !== undefined) {
    try { cache.put(key, JSON.stringify(value), ttl); } catch (e) { /* bỏ qua */ }
  }
  return value;
}

function cacheKey_(prefix, text) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(text), Utilities.Charset.UTF_8);
  return prefix + ':' + Utilities.base64EncodeWebSafe(digest);
}

function fetchJson_(url, options) {
  const response = UrlFetchApp.fetch(url, Object.assign({muteHttpExceptions: true}, options));
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw Error('Google Maps API lỗi ' + code + ': ' + body.slice(0, 300));
  return JSON.parse(body);
}

function inVietnam_(result) {
  return (result.address_components || []).some(c => c.types.includes('country') && c.short_name === 'VN');
}

/** Tra địa chỉ bằng Geocoder có sẵn (không cần key). Trả về tối đa 5 kết quả ở Việt Nam. */
function geocode_(query) {
  return cacheJson_(cacheKey_('geo', normalizeText_(query) + '|' + query), CACHE_TTL.geocode, () => {
    const response = Maps.newGeocoder().setRegion('vn').setLanguage('vi').geocode(query);
    return (response.results || []).filter(inVietnam_).slice(0, 5).map(r => ({
      placeId: r.place_id,
      text: r.formatted_address,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      precise: ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(r.geometry.location_type) && !r.partial_match,
    }));
  });
}

/** Places Autocomplete (New). */
function placesAutocomplete_(input, hub, sessionToken) {
  const center = HUB_CENTERS_[hub] || HUB_CENTERS_.HAN;
  const body = {
    input,
    languageCode: 'vi',
    regionCode: 'vn',
    includedRegionCodes: ['vn'],
    locationBias: {circle: {center: {latitude: center.lat, longitude: center.lng}, radius: 50000}},
  };
  if (sessionToken) body.sessionToken = String(sessionToken).slice(0, 64);
  const data = fetchJson_('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'post',
    contentType: 'application/json',
    headers: {'X-Goog-Api-Key': mapsApiKey_()},
    payload: JSON.stringify(body),
  });
  return (data.suggestions || []).filter(s => s.placePrediction).slice(0, 6).map(s => {
    const p = s.placePrediction;
    const main = p.structuredFormat?.mainText?.text || p.text?.text || '';
    const secondary = p.structuredFormat?.secondaryText?.text || '';
    return {placeId: p.placeId, text: p.text?.text || main, main, secondary};
  });
}

/**
 * Gợi ý địa chỉ khi người dùng gõ.
 * Trả về {suggestions: [{placeId?, text, main, secondary, lat?, lng?}], source, query}.
 */
function suggestAddresses(query, hub, sessionToken) {
  const q = String(query || '').trim().slice(0, 200);
  if (q.length < 3) return {suggestions: [], source: 'none', query: q};
  const coords = parseCoords_(q);
  if (coords) {
    return {suggestions: [{text: 'Tọa độ ' + coords.lat + ', ' + coords.lng, main: 'Tọa độ đã nhập',
      secondary: coords.lat + ', ' + coords.lng, lat: coords.lat, lng: coords.lng, precise: true}], source: 'coords', query: q};
  }
  const restored = restoreDiacritics_(q);
  if (mapsApiKey_()) {
    const key = cacheKey_('ac', hub + '|' + normalizeText_(q));
    const suggestions = cacheJson_(key, CACHE_TTL.geocode, () => {
      let list = placesAutocomplete_(q, hub, sessionToken);
      if (list.length < 3 && restored !== q) {
        const seen = new Set(list.map(s => s.placeId));
        list = list.concat(placesAutocomplete_(restored, hub, sessionToken).filter(s => !seen.has(s.placeId)));
      }
      return list.slice(0, 6);
    });
    return {suggestions, source: 'places', query: restored};
  }
  const seen = new Set();
  const suggestions = [];
  for (const text of restored !== q ? [restored, q] : [q]) {
    for (const r of geocode_(text + (/viet nam|việt nam/i.test(text) ? '' : ', Việt Nam'))) {
      if (seen.has(r.placeId)) continue;
      seen.add(r.placeId);
      const [main, ...rest] = r.text.split(', ');
      suggestions.push(Object.assign({main, secondary: rest.join(', ')}, r));
    }
  }
  return {suggestions: suggestions.slice(0, 6), source: 'geocoder', query: restored};
}

/** Lấy tọa độ của một gợi ý Places. Trả về {lat, lng, text, precise}. */
function resolvePlace(placeId, sessionToken) {
  const id = String(placeId || '');
  if (!/^[\w-]{10,300}$/.test(id)) throw Error('Gợi ý địa chỉ không hợp lệ.');
  return cacheJson_('place:' + id.slice(0, 200), CACHE_TTL.geocode, () => {
    if (!mapsApiKey_()) throw Error('Chưa cấu hình MAPS_API_KEY.');
    const token = sessionToken ? '&sessionToken=' + encodeURIComponent(String(sessionToken).slice(0, 64)) : '';
    const data = fetchJson_('https://places.googleapis.com/v1/places/' + encodeURIComponent(id) + '?languageCode=vi' + token, {
      headers: {'X-Goog-Api-Key': mapsApiKey_(), 'X-Goog-FieldMask': 'id,formattedAddress,location,types'},
    });
    if (!data.location) throw Error('Không lấy được tọa độ của địa chỉ này.');
    return {lat: data.location.latitude, lng: data.location.longitude, text: data.formattedAddress || '', precise: true};
  });
}

/** Điểm tham chiếu đã có tọa độ (cache): [đầu tuyến, nhãn tuyến, lat, lng]. */
function referencePoints_() {
  return cached_('points', CACHE_TTL.sheet, () => {
    const sheet = openDb_().getSheetByName(SHEETS.POINTS);
    if (!sheet || sheet.getLastRow() < 2) return [];
    const points = [];
    for (const [head, name, , lat, lng, status, , province] of sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues()) {
      if (status === 'Có tọa độ' && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat !== '' && lng !== '') {
        points.push([head, province + ' · ' + name, Number(lat), Number(lng)]);
      }
    }
    return points;
  });
}

/** Khoảng cách đường bộ (mét) từ origin tới từng điểm; null nếu không có đường. */
function roadDistances_(origin, destinations) {
  const round = v => Math.round(v * 1e4) / 1e4;
  const cache = CacheService.getScriptCache();
  const keyOf = d => 'dist:' + round(origin.lat) + ',' + round(origin.lng) + '>' + round(d.lat) + ',' + round(d.lng);
  const keys = destinations.map(keyOf);
  const hits = cache.getAll(keys);
  const result = keys.map(k => (k in hits ? JSON.parse(hits[k]) : undefined));
  const missing = result.map((v, i) => (v === undefined ? i : -1)).filter(i => i >= 0);
  if (!missing.length) return result;

  let measured = null;
  if (mapsApiKey_()) {
    try {
      measured = routeMatrix_(origin, missing.map(i => destinations[i]));
    } catch (e) {
      console.warn('Routes API lỗi, chuyển sang DirectionFinder: ' + e.message);
    }
  }
  if (!measured) {
    measured = missing.map(i => {
      const reply = Maps.newDirectionFinder().setOrigin(origin.lat, origin.lng)
        .setDestination(destinations[i].lat, destinations[i].lng)
        .setRegion('vn').setMode(Maps.DirectionFinder.Mode.DRIVING).getDirections();
      const meters = reply.routes?.[0]?.legs?.[0]?.distance?.value;
      return typeof meters === 'number' ? meters : null;
    });
  }
  const store = {};
  missing.forEach((i, j) => { result[i] = measured[j]; store[keys[i]] = JSON.stringify(measured[j]); });
  try { cache.putAll(store, CACHE_TTL.distance); } catch (e) { /* bỏ qua */ }
  return result;
}

/** Routes API computeRouteMatrix: 1 điểm đi × nhiều điểm đến trong một lần gọi. */
function routeMatrix_(origin, destinations) {
  const waypoint = p => ({waypoint: {location: {latLng: {latitude: p.lat, longitude: p.lng}}}});
  const data = fetchJson_('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
    method: 'post',
    contentType: 'application/json',
    headers: {'X-Goog-Api-Key': mapsApiKey_(), 'X-Goog-FieldMask': 'originIndex,destinationIndex,distanceMeters,condition'},
    payload: JSON.stringify({origins: [waypoint(origin)], destinations: destinations.map(waypoint), travelMode: 'DRIVE'}),
  });
  const out = destinations.map(() => null);
  for (const el of Array.isArray(data) ? data : []) {
    if (el.condition === 'ROUTE_EXISTS' && typeof el.distanceMeters === 'number') out[el.destinationIndex || 0] = el.distanceMeters;
  }
  return out;
}

/**
 * Tìm tuyến gần điểm giao nhất theo đường bộ (≤ 30 km).
 * place: chuỗi địa chỉ / "vĩ độ, kinh độ", hoặc {lat, lng, text, precise} từ gợi ý đã chọn.
 */
function nearbyRoutes(hub, mode, container, place) {
  let origin, label, precise = true;
  if (place && typeof place === 'object') {
    origin = {lat: Number(place.lat), lng: Number(place.lng)};
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) throw Error('Tọa độ không hợp lệ.');
    label = String(place.text || 'Điểm đã chọn').slice(0, 300);
    precise = place.precise !== false;
  } else {
    const q = String(place || '').trim().slice(0, 500);
    if (!q) throw Error('Nhập địa chỉ hoặc tọa độ.');
    origin = parseCoords_(q);
    label = 'Tọa độ đã nhập';
    if (!origin) {
      const restored = restoreDiacritics_(q);
      const results = geocode_(restored + (/viet nam|việt nam/i.test(restored) ? '' : ', Việt Nam'));
      if (!results.length) return {routes: [], message: 'Không tìm thấy địa chỉ. Chọn một gợi ý hoặc dán tọa độ từ Google Maps.'};
      origin = {lat: results[0].lat, lng: results[0].lng};
      label = results[0].text;
      precise = results[0].precise && results.length === 1;
    }
  }

  const labels = new Map(catalog(hub, mode, container).routes.map(([id, name]) => [name, id]));
  const nearest = new Map();
  for (const [head, name, lat, lng] of referencePoints_()) {
    const id = labels.get(name);
    if (head !== hub || !id) continue;
    const direct = directKm_(origin, {lat, lng});
    if (direct <= MAPS_LIMITS.maxDirectKm && direct < (nearest.get(id)?.direct ?? Infinity)) nearest.set(id, {id, name, lat, lng, direct});
  }
  const candidates = [...nearest.values()].sort((a, b) => a.direct - b.direct).slice(0, MAPS_LIMITS.maxDestinations);
  const suffix = precise ? '' : ' (vị trí ước tính)';
  if (!candidates.length) return {routes: [], origin, message: label + suffix + ' · Chưa có tuyến đã định vị trong ' + MAPS_LIMITS.maxDirectKm + ' km. Cần hỏi giá.'};

  const meters = roadDistances_(origin, candidates);
  const routes = candidates
    .map((c, i) => ({id: c.id, name: c.name, meters: meters[i], km: Math.round(meters[i] / 100) / 10}))
    .filter(r => typeof r.meters === 'number' && r.meters <= MAPS_LIMITS.maxRoadMeters)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, MAPS_LIMITS.maxResults);
  return {
    routes,
    origin,
    message: label + suffix + (routes.length ? ' · Chọn tuyến tham khảo (khoảng cách đường ô tô).' : ' · Không có tuyến trong 30 km đường bộ. Cần hỏi giá.'),
  };
}
