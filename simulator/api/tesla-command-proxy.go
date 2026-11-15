package handler

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/teslamotors/vehicle-command/pkg/protocol"
	"github.com/teslamotors/vehicle-command/pkg/proxy"
	"tesla-voice-mcp/gpscandidate"
	"tesla-voice-mcp/nativewaypoints"
	"tesla-voice-mcp/navigationcontracts"
)

const maxSignedCommandBody = 32 << 10

// The installation must explicitly supply its own canonical HTTPS origin.
func validPublicOrigin(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Hostname() == "" ||
		u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.String() != value ||
		!strings.Contains(u.Hostname(), ".") || net.ParseIP(u.Hostname()) != nil {
		return false
	}
	return true
}

// The SDK creates its own http.Client and drops the incoming context. Meter at
// the process transport boundary so session setup and retries cannot bypass the
// shared Redis ceiling. The Node reservation remains conservatively consumed.
type fleetBudgetTransport struct {
	base    http.RoundTripper
	reserve func(context.Context) error
}

// The Lambda/Vercel bootstrap also uses http.DefaultTransport. Only its
// runtime-owned loopback authority and protocol endpoints bypass Fleet metering.
// This is not a general localhost or arbitrary-HTTP exception.
func runtimeControlPlaneRequest(req *http.Request) bool {
	authority := os.Getenv("AWS_LAMBDA_RUNTIME_API")
	host, port, err := net.SplitHostPort(authority)
	ip := net.ParseIP(host)
	if err != nil || port == "" || ip == nil || !ip.IsLoopback() || req.URL.Scheme != "http" || req.URL.Host != authority || req.URL.User != nil || req.URL.RawQuery != "" || req.URL.Fragment != "" {
		return false
	}
	const root = "/2018-06-01/runtime/"
	if req.Method == http.MethodGet {
		return req.URL.Path == root+"invocation/next"
	}
	if req.Method != http.MethodPost {
		return false
	}
	if req.URL.Path == root+"init/error" {
		return true
	}
	parts := strings.Split(strings.TrimPrefix(req.URL.Path, root+"invocation/"), "/")
	return strings.HasPrefix(req.URL.Path, root+"invocation/") && len(parts) == 2 &&
		regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`).MatchString(parts[0]) && (parts[1] == "response" || parts[1] == "error")
}

func (t fleetBudgetTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if runtimeControlPlaneRequest(req) {
		return t.base.RoundTrip(req)
	}
	store, err := url.Parse(os.Getenv("TOKEN_STORE_REST_URL"))
	if err == nil && store.Scheme == "https" && req.URL.Scheme == "https" && req.URL.Host == store.Host && req.URL.Path == store.Path {
		return t.base.RoundTrip(req)
	}
	if req.URL.Scheme != "https" || req.URL.Host != "fleet-api.prd.eu.vn.cloud.tesla.com" {
		return nil, errors.New("outbound destination denied")
	}
	if err := t.reserve(req.Context()); err != nil {
		return nil, errors.New("fleet request budget unavailable")
	}
	return t.base.RoundTrip(req)
}

func init() {
	base := http.DefaultTransport
	http.DefaultTransport = fleetBudgetTransport{base: base, reserve: func(ctx context.Context) error {
		started := time.Now()
		err := reserveFleetHTTPRequest(ctx, base, started)
		if time.Now().UTC().Format("2006-01-02") != started.UTC().Format("2006-01-02") {
			return errors.New("budget day changed")
		}
		return err
	}}
}

func reserveFleetHTTPRequest(ctx context.Context, base http.RoundTripper, now time.Time) error {
	limit, err := strconv.Atoi(os.Getenv("TESLA_DAILY_READ_LIMIT"))
	unlimited := os.Getenv("VERCEL_ENV") == "production" || os.Getenv("TESLA_DAILY_READ_LIMIT") == "unlimited"
	if !unlimited && (err != nil || limit < 1 || limit > 50) {
		return errors.New("budget configuration")
	}
	endpoint, err := url.Parse(os.Getenv("TOKEN_STORE_REST_URL"))
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || os.Getenv("TOKEN_STORE_REST_TOKEN") == "" {
		return errors.New("store unavailable")
	}
	// Single atomic operation covers all legacy slots, including sparse ones.
	script := "local raw=redis.call('GET',ARGV[2]); local extra=tonumber(raw or '0'); if not extra or extra<0 or extra~=math.floor(extra) or extra>9007199254740891 then return -1 end; local used=extra; local free=nil; for i=1,#KEYS do local v=redis.call('GET',KEYS[i]); if v then if v~='1' then return -1 end; used=used+1 elseif ARGV[1]~='unlimited' and i<=tonumber(ARGV[1]) and not free then free=KEYS[i] end end; if ARGV[1]=='unlimited' then redis.call('INCRBY',ARGV[2],1); redis.call('EXPIRE',ARGV[2],172800); return 1 end; if used>=tonumber(ARGV[1]) or not free then return 0 end; redis.call('SET',free,'1','EX',172800); return 1"
	args := []any{"EVAL", script, 50}
	for slot := 0; slot < 50; slot++ {
		args = append(args, fmt.Sprintf("tesla-voice:v1:read-budget:%s:%d", now.UTC().Format("2006-01-02"), slot))
	}
	if unlimited {
		args = append(args, "unlimited")
	} else {
		args = append(args, limit)
	}
	args = append(args, "tesla-voice:v1:read-budget-extra:"+now.UTC().Format("2006-01-02"))
	body, _ := json.Marshal(args)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return errors.New("store unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("TOKEN_STORE_REST_TOKEN"))
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: base, Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("store unavailable")
	}
	defer resp.Body.Close()
	var result struct {
		Result int    `json:"result"`
		Error  string `json:"error"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode != http.StatusOK || decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF || result.Result != 1 || result.Error != "" {
		return errors.New("budget exhausted or unavailable")
	}
	return nil
}

var (
	vinPattern                = regexp.MustCompile(`^[A-HJ-NPR-Z0-9]{17}$`)
	noncePattern              = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	navigationScopePattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	hexDiagnosticSessionID    = regexp.MustCompile(`^[a-f0-9]{32}$`)
	hexDiagnosticAccountScope = regexp.MustCompile(`^[a-f0-9]{64}$`)
	commandNames              = map[string]bool{
		"clear_pin_to_drive_admin": true, "reset_pin_to_drive_pin": true,
		"reset_valet_pin": true, "speed_limit_clear_pin_admin": true, "erase_user_data": true,
		"set_pin_to_drive": true, "set_valet_mode": true, "speed_limit_activate": true,
		"speed_limit_deactivate": true, "speed_limit_clear_pin": true,
		"parental_controls_activate": true, "parental_controls_deactivate": true,
		"parental_controls_enable_setting": true, "parental_controls_set_speed_limit": true,
		"parental_controls_clear_pin_admin": true,
		"navigation_gps_request":            true, "navigation_sc_request": true,
		"navigation_waypoints_request": true, "sun_roof_control": true,
		"upcoming_calendar_entries": true,
		"navigation_request":        true,
		"charge_start":              true, "charge_stop": true, "charge_standard": true, "charge_max_range": true, "set_charge_limit": true,
		"set_charging_amps": true, "set_scheduled_charging": true, "set_scheduled_departure": true,
		"add_charge_schedule": true, "remove_charge_schedule": true, "add_precondition_schedule": true, "remove_precondition_schedule": true,
		"auto_conditioning_start": true, "auto_conditioning_stop": true,
		"set_temps": true, "remote_seat_heater_request": true, "remote_seat_cooler_request": true,
		"remote_auto_seat_climate_request":     true,
		"remote_steering_wheel_heater_request": true, "remote_auto_steering_wheel_heat_climate_request": true,
		"remote_steering_wheel_heat_level_request": true, "set_climate_keeper_mode": true, "set_cop_temp": true,
		"set_bioweapon_mode": true, "set_preconditioning_max": true,
		"set_cabin_overheat_protection": true, "set_low_power_mode": true, "keep_accessory_power_mode": true,
		"wake_up": true, "door_lock": true, "door_unlock": true,
		"set_sentry_mode": true, "guest_mode": true, "remote_start_drive": true, "trigger_homelink": true,
		"set_vehicle_name": true, "window_control": true, "actuate_trunk": true,
		"charge_port_door_open": true, "charge_port_door_close": true,
		"flash_lights": true, "honk_horn": true, "remote_boombox": true, "speed_limit_set_limit": true, "media_toggle_playback": true,
		"media_next_track": true, "media_prev_track": true, "media_volume_up": true,
		"media_volume_down": true, "media_next_fav": true, "media_prev_fav": true,
		"adjust_volume": true, "schedule_software_update": true, "cancel_software_update": true,
	}
	commandFields = map[string]map[string]bool{
		"parental_controls_activate":                      {"pin": true},
		"parental_controls_deactivate":                    {"pin": true},
		"parental_controls_enable_setting":                {"setting": true, "enable": true},
		"parental_controls_set_speed_limit":               {"limit_mph": true},
		"set_pin_to_drive":                                {"on": true, "pin": true},
		"set_valet_mode":                                  {"on": true, "pin": true},
		"sun_roof_control":                                {"state": true},
		"speed_limit_activate":                            {"pin": true},
		"speed_limit_deactivate":                          {"pin": true},
		"speed_limit_clear_pin":                           {"pin": true},
		"navigation_request":                              {"destination": true},
		"navigation_waypoints_request":                    {"waypoints": true},
		"navigation_sc_request":                           {"site_id": true},
		"navigation_gps_request":                          {"points": true},
		"set_charge_limit":                                {"percent": true},
		"set_charging_amps":                               {"charging_amps": true},
		"set_scheduled_charging":                          {"enable": true, "time": true},
		"set_scheduled_departure":                         {"enable": true, "departure_time": true, "end_off_peak_time": true, "off_peak_charging_enabled": true, "off_peak_charging_weekdays_only": true, "preconditioning_enabled": true, "preconditioning_weekdays_only": true},
		"add_charge_schedule":                             {"lat": true, "lon": true, "start_time": true, "start_enabled": true, "end_time": true, "end_enabled": true, "days_of_week": true, "id": true, "enabled": true, "one_time": true},
		"remove_charge_schedule":                          {"id": true},
		"add_precondition_schedule":                       {"lat": true, "lon": true, "precondition_time": true, "days_of_week": true, "id": true, "one_time": true, "enabled": true},
		"remove_precondition_schedule":                    {"id": true},
		"set_temps":                                       {"driver_temp": true, "passenger_temp": true},
		"remote_seat_heater_request":                      {"seat_position": true, "level": true},
		"remote_seat_cooler_request":                      {"seat_position": true, "seat_cooler_level": true},
		"remote_auto_seat_climate_request":                {"auto_seat_position": true, "auto_climate_on": true},
		"remote_steering_wheel_heater_request":            {"on": true},
		"remote_auto_steering_wheel_heat_climate_request": {"on": true},
		"remote_steering_wheel_heat_level_request":        {"level": true},
		"set_bioweapon_mode":                              {"on": true, "manual_override": true},
		"set_preconditioning_max":                         {"on": true, "manual_override": true},
		"set_climate_keeper_mode":                         {"climate_keeper_mode": true},
		"set_cop_temp":                                    {"cop_temp": true},
		"set_cabin_overheat_protection":                   {"on": true, "fan_only": true},
		"set_low_power_mode":                              {"enable": true},
		"keep_accessory_power_mode":                       {"enable": true},
		"set_sentry_mode":                                 {"on": true},
		"remote_boombox":                                  {"sound_id": true}, "speed_limit_set_limit": {"limit_mph": true},
		"guest_mode":               {"enable": true},
		"trigger_homelink":         {"lat": true, "lon": true},
		"set_vehicle_name":         {"vehicle_name": true},
		"window_control":           {"command": true},
		"actuate_trunk":            {"which_trunk": true},
		"adjust_volume":            {"volume": true},
		"schedule_software_update": {"offset_sec": true},
	}
)

type commandEnvelope struct {
	RouteDeadlineMillis  int64                  `json:"route_deadline_unix_ms,omitempty"`
	NavigationGuardOwner string                 `json:"navigation_guard_owner,omitempty"`
	NavigationGuardScope string                 `json:"navigation_guard_scope,omitempty"`
	GPSDiagnostic        *gpsDiagnosticEnvelope `json:"gps_diagnostic,omitempty"`
	VIN                  string                 `json:"vin"`
	Operation            string                 `json:"operation"`
	Arguments            map[string]any         `json:"arguments"`
	AccessToken          string                 `json:"access_token"`
	PrivateKeyPEM        string                 `json:"private_key_pem"`
	Nonce                string                 `json:"nonce"`
}

type gpsDiagnosticPoint struct {
	Lat *float64 `json:"lat"`
	Lon *float64 `json:"lon"`
}

type gpsDiagnosticEnvelope struct {
	SessionID      string              `json:"session_id"`
	AccountScope   string              `json:"account_scope"`
	Phase          string              `json:"phase"`
	ExpectedAppend *gpsDiagnosticPoint `json:"expected_append_point,omitempty"`
	DisplayChecked bool                `json:"display_checked,omitempty"`
}

func gpsDiagnosticPointFrom(args map[string]any) (gpscandidate.Point, bool) {
	if len(args) != 1 {
		return gpscandidate.Point{}, false
	}
	raw, ok := args["points"].([]any)
	if !ok || len(raw) != 1 {
		return gpscandidate.Point{}, false
	}
	p, ok := raw[0].(map[string]any)
	if !ok || len(p) != 2 {
		return gpscandidate.Point{}, false
	}
	lat, a := p["lat"].(float64)
	lon, b := p["lon"].(float64)
	point := gpscandidate.Point{Latitude: lat, Longitude: lon}
	if !a || !b || gpscandidate.ValidatePoint(point) != nil {
		return gpscandidate.Point{}, false
	}
	return point, true
}

func validGPSDiagnosticEnvelope(e commandEnvelope) bool {
	d := e.GPSDiagnostic
	if d == nil || e.Operation != "navigation_gps_request" || !hexDiagnosticSessionID.MatchString(d.SessionID) || !hexDiagnosticAccountScope.MatchString(d.AccountScope) {
		return false
	}
	if _, ok := gpsDiagnosticPointFrom(e.Arguments); !ok {
		return false
	}
	switch d.Phase {
	case "replace":
		return d.ExpectedAppend != nil && d.ExpectedAppend.Lat != nil && d.ExpectedAppend.Lon != nil && !d.DisplayChecked && gpscandidate.ValidatePoint(gpscandidate.Point{Latitude: *d.ExpectedAppend.Lat, Longitude: *d.ExpectedAppend.Lon}) == nil
	case "append":
		return d.ExpectedAppend == nil && d.DisplayChecked
	default:
		return false
	}
}

func validCommandEnvelopeArguments(e commandEnvelope) bool {
	if e.GPSDiagnostic != nil {
		return validGPSDiagnosticEnvelope(e)
	}
	return validateArguments(e.Operation, e.Arguments)
}

func replyError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

func encryptionKey() ([]byte, error) {
	encoded := os.Getenv("TOKEN_ENCRYPTION_KEY_BASE64")
	legacy := os.Getenv("TOKEN_ENCRYPTON_KEY_BASE64")
	if encoded != "" && legacy != "" && encoded != legacy {
		return nil, errors.New("invalid configuration")
	}
	if encoded == "" {
		encoded = legacy
	}
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return nil, errors.New("invalid configuration")
	}
	return key, nil
}

func verifySignature(key, body []byte, timestamp, signature string, now time.Time) bool {
	stamp, err := strconv.ParseInt(timestamp, 10, 64)
	nowMillis := now.UnixMilli()
	if err != nil || stamp < nowMillis-30_000 || stamp > nowMillis+30_000 {
		return false
	}
	provided, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(provided) != sha256.Size {
		return false
	}
	derive := hmac.New(sha256.New, key)
	_, _ = derive.Write([]byte("tesla-command-proxy-v1"))
	signingKey := derive.Sum(nil)
	mac := hmac.New(sha256.New, signingKey)
	_, _ = mac.Write([]byte(timestamp + "\n"))
	_, _ = mac.Write(body)
	return hmac.Equal(provided, mac.Sum(nil))
}

func claimNonce(ctx context.Context, nonce string) error {
	endpoint, err := url.Parse(os.Getenv("TOKEN_STORE_REST_URL"))
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("store unavailable")
	}
	token := os.Getenv("TOKEN_STORE_REST_TOKEN")
	if token == "" {
		return errors.New("store unavailable")
	}
	command, _ := json.Marshal([]any{"SET", "tesla-voice:v1:command-proxy-nonce:" + nonce, "1", "NX", "EX", "120"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(command))
	if err != nil {
		return errors.New("store unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("store unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New("store unavailable")
	}
	var result struct {
		Result string `json:"result"`
		Error  string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1024)).Decode(&result); err != nil || result.Error != "" {
		return errors.New("store unavailable")
	}
	if result.Result != "OK" {
		return errors.New("nonce already used")
	}
	return nil
}

func number(args map[string]any, key string, min, max float64, integer bool) bool {
	value, ok := args[key].(float64)
	if !ok || value < min || value > max {
		return false
	}
	return !integer || value == float64(int64(value))
}

func boolean(args map[string]any, key string) bool {
	_, ok := args[key].(bool)
	return ok
}

func validDays(value any) bool {
	days, ok := value.(string)
	if !ok || len(days) == 0 || len(days) > 80 {
		return false
	}
	allowed := map[string]bool{"SUN": true, "SUNDAY": true, "MON": true, "MONDAY": true, "TUES": true, "TUESDAY": true,
		"WED": true, "WEDNESDAY": true, "THURS": true, "THURSDAY": true, "FRI": true, "FRIDAY": true,
		"SAT": true, "SATURDAY": true, "ALL": true, "WEEKDAYS": true}
	for _, day := range strings.Split(days, ",") {
		if !allowed[strings.ToUpper(strings.TrimSpace(day))] {
			return false
		}
	}
	return true
}

func validateArguments(operation string, args map[string]any) bool {
	if args == nil {
		return false
	}
	fields := commandFields[operation]
	for key := range args {
		if !fields[key] {
			return false
		}
	}
	validPIN := func(value any) bool {
		pin, ok := value.(string)
		if !ok || len(pin) != 4 {
			return false
		}
		for _, digit := range pin {
			if digit < '0' || digit > '9' {
				return false
			}
		}
		return true
	}
	switch operation {
	case "navigation_gps_request":
		_, ok := gpsRoutePoints(args)
		return ok
	case "navigation_waypoints_request":
		value, ok := args["waypoints"].(string)
		if !ok {
			return false
		}
		if nativewaypoints.Valid(value) {
			return true
		}
		_, err := navigationcontracts.ParseCoordinateString(value)
		return err == nil
	case "navigation_sc_request":
		id, ok := args["site_id"].(string)
		if !ok {
			return false
		}
		_, err := navigationcontracts.EncodeSuperchargerCandidate(id, navigationcontracts.SuperchargerSchema)
		return err == nil
	case "parental_controls_activate", "parental_controls_deactivate":
		return validPIN(args["pin"])
	case "parental_controls_enable_setting":
		setting, ok := args["setting"].(string)
		if !ok || !boolean(args, "enable") {
			return false
		}
		switch setting {
		case "speed_limit", "acceleration", "safety_features", "curfew", "browser_blocked", "theater_blocked", "arcade_blocked":
			return true
		default:
			return false
		}
	case "parental_controls_set_speed_limit":
		return number(args, "limit_mph", 50, 90, true)
	case "set_pin_to_drive", "set_valet_mode":
		on, ok := args["on"].(bool)
		if !ok {
			return false
		}
		if on {
			return validPIN(args["pin"])
		}
		_, hasPIN := args["pin"]
		return !hasPIN
	case "speed_limit_activate", "speed_limit_deactivate", "speed_limit_clear_pin":
		return validPIN(args["pin"])
	case "sun_roof_control":
		state, ok := args["state"].(string)
		return ok && (state == "stop" || state == "close" || state == "vent")
	case "navigation_request":
		v, ok := args["destination"].(string)
		return ok && strings.TrimSpace(v) != "" && len(v) <= 256
	case "set_charge_limit":
		return number(args, "percent", 50, 100, true)
	case "set_charging_amps":
		return number(args, "charging_amps", 1, 48, true)
	case "set_scheduled_charging":
		_, enablePresent := args["enable"]
		_, timePresent := args["time"]
		return enablePresent && boolean(args, "enable") && timePresent && number(args, "time", 0, 1439, true)
	case "set_scheduled_departure":
		if !boolean(args, "enable") {
			return false
		}
		for _, key := range []string{"off_peak_charging_enabled", "off_peak_charging_weekdays_only", "preconditioning_enabled", "preconditioning_weekdays_only"} {
			if _, present := args[key]; present && !boolean(args, key) {
				return false
			}
		}
		if !args["enable"].(bool) {
			return len(args) == 1
		}
		return number(args, "departure_time", 0, 1439, true) && number(args, "end_off_peak_time", 0, 1439, true)
	case "add_charge_schedule":
		return number(args, "lat", -90, 90, false) && number(args, "lon", -180, 180, false) &&
			number(args, "start_time", 0, 1439, true) && boolean(args, "start_enabled") &&
			number(args, "end_time", 0, 1439, true) && boolean(args, "end_enabled") && validDays(args["days_of_week"]) &&
			boolean(args, "enabled") && (args["id"] == nil || number(args, "id", 0, 9007199254740991, true)) &&
			(args["one_time"] == nil || boolean(args, "one_time"))
	case "remove_charge_schedule":
		return number(args, "id", 1, 9007199254740991, true)
	case "add_precondition_schedule":
		return number(args, "lat", -90, 90, false) && number(args, "lon", -180, 180, false) &&
			number(args, "precondition_time", 0, 1439, true) && validDays(args["days_of_week"]) && boolean(args, "enabled") &&
			(args["id"] == nil || number(args, "id", 0, 9007199254740991, true)) && (args["one_time"] == nil || boolean(args, "one_time"))
	case "remove_precondition_schedule":
		return number(args, "id", 1, 9007199254740991, true)
	case "set_temps":
		return number(args, "driver_temp", 15, 30, false) && number(args, "passenger_temp", 15, 30, false)
	case "remote_seat_heater_request":
		return number(args, "seat_position", 0, 8, true) && number(args, "level", 0, 3, true)
	case "remote_seat_cooler_request":
		return number(args, "seat_position", 0, 1, true) && number(args, "seat_cooler_level", 1, 3, true)
	case "remote_auto_seat_climate_request":
		return number(args, "auto_seat_position", 0, 1, true) && boolean(args, "auto_climate_on")
	case "remote_steering_wheel_heater_request", "remote_auto_steering_wheel_heat_climate_request", "set_sentry_mode":
		return boolean(args, "on")
	case "remote_steering_wheel_heat_level_request":
		return number(args, "level", 0, 3, true)
	case "set_low_power_mode", "keep_accessory_power_mode", "guest_mode":
		return boolean(args, "enable")
	case "set_bioweapon_mode":
		return boolean(args, "on") && boolean(args, "manual_override")
	case "set_preconditioning_max":
		return boolean(args, "on") && (args["manual_override"] == nil || boolean(args, "manual_override"))
	case "set_climate_keeper_mode":
		return number(args, "climate_keeper_mode", 0, 3, true)
	case "set_cop_temp":
		return number(args, "cop_temp", 0, 2, true)
	case "set_cabin_overheat_protection":
		return boolean(args, "on") && boolean(args, "fan_only")
	case "window_control":
		v, ok := args["command"].(string)
		return ok && (v == "close" || v == "vent")
	case "actuate_trunk":
		v, ok := args["which_trunk"].(string)
		return ok && (v == "front" || v == "rear")
	case "adjust_volume":
		return number(args, "volume", 0, 100, false)
	case "remote_boombox":
		return number(args, "sound_id", 2000, 2000, true)
	case "speed_limit_set_limit":
		return number(args, "limit_mph", 50, 90, true)
	case "trigger_homelink":
		return number(args, "lat", -90, 90, false) && number(args, "lon", -180, 180, false)
	case "set_vehicle_name":
		name, ok := args["vehicle_name"].(string)
		return ok && strings.TrimSpace(name) != "" && len(name) <= 64
	case "schedule_software_update":
		return number(args, "offset_sec", 0, 2592000, true)
	default:
		return len(fields) == 0 && len(args) == 0
	}
}

func proxyCommandArguments(operation string, args map[string]any, now time.Time) (map[string]any, error) {
	if operation == "parental_controls_enable_setting" {
		settingNames := map[string]string{
			"speed_limit": "SpeedLimit", "acceleration": "Acceleration", "safety_features": "SafetyFeatures",
			"curfew": "Curfew", "browser_blocked": "BrowserBlocked", "theater_blocked": "TheaterBlocked", "arcade_blocked": "ArcadeBlocked",
		}
		setting, ok := args["setting"].(string)
		if !ok || settingNames[setting] == "" {
			return nil, errors.New("invalid parental controls setting")
		}
		return map[string]any{"setting": settingNames[setting], "enable": args["enable"]}, nil
	}
	if operation == "set_pin_to_drive" || operation == "set_valet_mode" {
		mapped := map[string]any{"on": args["on"]}
		if pin, ok := args["pin"].(string); ok {
			mapped["password"] = pin
		}
		return mapped, nil
	}
	if operation == "navigation_request" {
		destination, ok := args["destination"].(string)
		if !ok || strings.TrimSpace(destination) == "" || len(destination) > 256 {
			return nil, errors.New("invalid navigation destination")
		}
		return map[string]any{
			"type":         "share_ext_content_raw",
			"locale":       "it-IT",
			"timestamp_ms": strconv.FormatInt(now.UnixMilli(), 10),
			"value":        map[string]string{"android.intent.extra.TEXT": destination},
		}, nil
	}
	return args, nil
}

// Navigation requests are REST passthrough operations in vehicle-command. The
// SDK command handler consumes the body before selecting that fallback, so send
// the validated body directly and never replay an uncertain request.
func serveNavigationRequest(w http.ResponseWriter, r *http.Request, envelope commandEnvelope, body []byte, client *http.Client) {
	endpoint := "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/" + envelope.VIN + "/command/navigation_request"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	req.Header.Set("Authorization", "Bearer "+envelope.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		// Tesla may have received the request. Never retry navigation implicitly.
		replyError(w, http.StatusBadGateway, "command_outcome_unknown")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			replyError(w, resp.StatusCode, "permission")
		case http.StatusRequestTimeout:
			replyError(w, resp.StatusCode, "vehicle_unavailable")
		default:
			replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		}
		return
	}
	var result struct {
		Response struct {
			Result *bool `json:"result"`
		} `json:"response"`
		Error string `json:"error"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 65537))
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF {
		replyError(w, http.StatusBadGateway, "command_outcome_unknown")
		return
	}
	if result.Response.Result == nil || result.Error != "" {
		replyError(w, http.StatusBadGateway, "command_outcome_unknown")
		return
	}
	if !*result.Response.Result {
		replyError(w, http.StatusConflict, "command_rejected")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true})
}

// Wake is a Fleet REST operation, not a signed vehicle command. The MCP backend
// authorizes it before signing this envelope; the proxy also reserves its nonce.
func serveWake(w http.ResponseWriter, r *http.Request, envelope commandEnvelope, client *http.Client) {
	endpoint := "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/" + envelope.VIN + "/wake_up"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, strings.NewReader("{}"))
	if err != nil {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	req.Header.Set("Authorization", "Bearer "+envelope.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		// The request might have reached Tesla: never retry an uncertain wake.
		replyError(w, http.StatusBadGateway, "command_outcome_unknown")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			replyError(w, resp.StatusCode, "permission")
		case http.StatusRequestTimeout:
			replyError(w, resp.StatusCode, "vehicle_unavailable")
		default:
			replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		}
		return
	}
	var result struct {
		Response struct {
			State string `json:"state"`
		} `json:"response"`
		Error string `json:"error"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 65537))
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF || result.Error != "" ||
		(result.Response.State != "online" && result.Response.State != "asleep" && result.Response.State != "offline") {
		replyError(w, http.StatusBadGateway, "command_outcome_unknown")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true})
}

// Receipts contain no VIN, destination, token or key. They permit reconciliation
// after a lost HTTP reply; absence of a receipt never proves a command failed.
func commandReceipt(nonce, operation string, forwarded bool, response *httptest.ResponseRecorder) map[string]any {
	var body struct {
		Accepted bool   `json:"accepted"`
		Error    string `json:"error"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	state := "uncertain"
	if response.Code == http.StatusOK && body.Accepted {
		state = "acknowledged"
	} else if !forwarded || (operation == "navigation_request" || operation == "navigation_waypoints_request" || operation == "navigation_sc_request") && (body.Error == "command_rejected" || body.Error == "permission") {
		state = "failed"
	}
	return map[string]any{"version": 1, "nonce": nonce, "state": state,
		"definitive_no_effect": state == "failed", "proxy_accepted": true,
		"observed_at": time.Now().UTC().Format(time.RFC3339Nano)}
}

func saveCommandReceipt(receipt map[string]any) error {
	endpoint, err := url.Parse(os.Getenv("TOKEN_STORE_REST_URL"))
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || os.Getenv("TOKEN_STORE_REST_TOKEN") == "" {
		return errors.New("store unavailable")
	}
	data, _ := json.Marshal(receipt)
	body, _ := json.Marshal([]any{"SET", "tesla-voice:v1:command-proxy-receipt:" + receipt["nonce"].(string), string(data), "NX"})
	// Retain evidence when the caller disconnected. This does not make a Tesla request.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+os.Getenv("TOKEN_STORE_REST_TOKEN"))
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("store unavailable")
	}
	defer resp.Body.Close()
	var result struct {
		Result string `json:"result"`
		Error  string `json:"error"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode != http.StatusOK || decoder.Decode(&result) != nil || result.Error != "" || result.Result != "OK" {
		return errors.New("store unavailable")
	}
	return nil
}

func Handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// The signer is production-only, even if a Preview accidentally receives
	// similarly named environment variables or a caller reaches the raw route.
	if os.Getenv("VERCEL_ENV") != "production" ||
		!validPublicOrigin(os.Getenv("APP_ORIGIN")) ||
		os.Getenv("TESLA_FLEET_REGION") != "eu" ||
		os.Getenv("TESLA_REAL_RELEASE_APPROVED") != "true" ||
		os.Getenv("TESLA_BACKEND_ENABLED") != "true" ||
		os.Getenv("TESLA_READ_ENABLED") != "true" ||
		os.Getenv("TESLA_COMMANDS_ENABLED") != "true" ||
		os.Getenv("TESLA_COMMAND_EXECUTION_ENABLED") != "true" {
		log.Print("TESLA_PROXY_GATE_DENIED configuration")
		replyError(w, http.StatusNotFound, "not_found")
		return
	}
	if r.URL.Path != "/api/tesla-command-proxy" {
		log.Print("TESLA_PROXY_GATE_DENIED path")
		replyError(w, http.StatusNotFound, "not_found")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		replyError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]) != "application/json" || len(r.Header.Values("X-Tesla-Command-Time")) != 1 || len(r.Header.Values("X-Tesla-Command-Signature")) != 1 {
		replyError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSignedCommandBody))
	if err != nil {
		replyError(w, http.StatusRequestEntityTooLarge, "request_too_large")
		return
	}
	key, err := encryptionKey()
	if err != nil || !verifySignature(key, body, r.Header.Get("X-Tesla-Command-Time"), r.Header.Get("X-Tesla-Command-Signature"), time.Now()) {
		replyError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var envelope commandEnvelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil || decoder.Decode(new(any)) != io.EOF ||
		!vinPattern.MatchString(envelope.VIN) || !commandNames[envelope.Operation] ||
		!noncePattern.MatchString(envelope.Nonce) || len(envelope.AccessToken) == 0 || len(envelope.AccessToken) > 16384 ||
		len(envelope.PrivateKeyPEM) == 0 || len(envelope.PrivateKeyPEM) > 4000 || !validCommandEnvelopeArguments(envelope) {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	nativeMode := nativeCandidateMode(envelope)
	if nativeMode != "" && !nativeCandidateEnabled(nativeMode) {
		replyError(w, 400, "command_transport_unsupported")
		return
	}
	if envelope.Operation == "navigation_gps_request" || nativeMode != "" {
		if envelope.Operation == "navigation_gps_request" && (os.Getenv("TESLA_GPS_ROUTE_CANDIDATE_ENABLED") != "true" || os.Getenv("TESLA_GPS_ROUTE_ORDER_SCHEMA") != gpscandidate.ExperimentalOrderSchema) {
			replyError(w, 400, "command_transport_unsupported")
			return
		}
		stamp, _ := strconv.ParseInt(r.Header.Get("X-Tesla-Command-Time"), 10, 64)
		if !noncePattern.MatchString(envelope.NavigationGuardOwner) || envelope.RouteDeadlineMillis <= 0 || envelope.RouteDeadlineMillis > stamp+24000 || envelope.RouteDeadlineMillis > time.Now().UnixMilli()+24000 {
			replyError(w, 400, "invalid_command")
			return
		}
		// An expired replay might refer to an earlier dispatch: do not fabricate
		// definitive-no-effect evidence before checking its original receipt.
		if envelope.RouteDeadlineMillis <= time.Now().UnixMilli() {
			replyError(w, 400, "command_outcome_unknown")
			return
		}
		ctx, cancel := context.WithDeadline(r.Context(), time.UnixMilli(envelope.RouteDeadlineMillis))
		defer cancel()
		r = r.WithContext(ctx)
	} else if envelope.RouteDeadlineMillis != 0 || envelope.NavigationGuardOwner != "" {
		replyError(w, 400, "invalid_command")
		return
	}
	if envelope.Operation == "navigation_waypoints_request" && nativeMode == "" && os.Getenv("TESLA_NATIVE_WAYPOINTS_ENABLED") != "true" {
		replyError(w, http.StatusBadRequest, "command_transport_unsupported")
		return
	}
	if err := claimNonce(r.Context(), envelope.Nonce); err != nil {
		log.Print("TESLA_PROXY_FAILURE nonce")
		if err.Error() == "nonce already used" {
			replyError(w, http.StatusConflict, "command_replayed")
		} else {
			replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		}
		return
	}

	outer := w
	captured := httptest.NewRecorder()
	w = captured
	forwarded := false
	defer func() {
		receipt := commandReceipt(envelope.Nonce, envelope.Operation, forwarded, captured)
		if err := saveCommandReceipt(receipt); err != nil {
			log.Print("TESLA_PROXY_RECEIPT_STORE_FAILED")
		}
		var body map[string]any
		if json.Unmarshal(captured.Body.Bytes(), &body) == nil {
			body["command_evidence"] = receipt
			captured.Body.Reset()
			_ = json.NewEncoder(captured.Body).Encode(body)
		}
		for key, values := range captured.Header() {
			outer.Header()[key] = values
		}
		outer.WriteHeader(captured.Code)
		_, _ = outer.Write(captured.Body.Bytes())
	}()
	if envelope.Operation == "wake_up" {
		forwarded = true
		client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		serveWake(w, r, envelope, client)
		return
	}

	keyFile, err := os.CreateTemp("", "tesla-vcp-key-*.pem")
	if err != nil {
		log.Print("TESLA_PROXY_FAILURE key_temp")
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	keyPath := keyFile.Name()
	defer os.Remove(keyPath)
	if err := keyFile.Chmod(0600); err != nil {
		log.Print("TESLA_PROXY_FAILURE key_permissions")
		_ = keyFile.Close()
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	if _, err := io.WriteString(keyFile, envelope.PrivateKeyPEM); err != nil {
		log.Print("TESLA_PROXY_FAILURE key_write")
		_ = keyFile.Close()
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	if err := keyFile.Close(); err != nil {
		log.Print("TESLA_PROXY_FAILURE key_close")
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	commandKey, err := protocol.LoadPrivateKey(keyPath)
	if err != nil {
		log.Print("TESLA_PROXY_FAILURE key_load")
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	if nativeMode != "" {
		serveNativeCandidate(w, r, envelope, commandKey, &forwarded, nativeMode)
		return
	}
	if envelope.Operation == "navigation_gps_request" {
		if envelope.GPSDiagnostic != nil {
			serveGPSDiagnostic(w, r, envelope, commandKey, &forwarded)
			return
		}
		serveGPSRoute(w, r, envelope, commandKey, &forwarded)
		return
	}
	proxyHandler, err := proxy.New(context.Background(), commandKey, 128)
	if err != nil {
		log.Print("TESLA_PROXY_FAILURE proxy_init")
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	proxyHandler.Timeout = 12 * time.Second

	proxyArguments, err := proxyCommandArguments(envelope.Operation, envelope.Arguments, time.Now())
	if err != nil {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	var commandBuffer bytes.Buffer
	commandEncoder := json.NewEncoder(&commandBuffer)
	commandEncoder.SetEscapeHTML(false)
	if err := commandEncoder.Encode(proxyArguments); err != nil {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	commandBody := bytes.TrimSuffix(commandBuffer.Bytes(), []byte("\n"))
	if len(commandBody) > 500 {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	if envelope.Operation == "navigation_request" {
		forwarded = true
		client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		serveNavigationRequest(w, r, envelope, commandBody, client)
		return
	}
	path := fmt.Sprintf("/api/1/vehicles/%s/command/%s", envelope.VIN, envelope.Operation)
	proxyRequest, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://fleet-api.prd.eu.vn.cloud.tesla.com"+path, bytes.NewReader(commandBody))
	if err != nil {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	proxyRequest.Header.Set("Authorization", "Bearer "+envelope.AccessToken)
	proxyRequest.Header.Set("Content-Type", "application/json")
	proxyRequest.Header.Set("Accept", "application/json")
	proxyRequest.RemoteAddr = "127.0.0.1:443"
	recorder := httptest.NewRecorder()
	forwarded = true
	proxyHandler.ServeHTTP(recorder, proxyRequest)

	if recorder.Code != http.StatusOK {
		log.Printf("TESLA_PROXY_HTTP_STATUS %d", recorder.Code)
		switch recorder.Code {
		case http.StatusRequestTimeout:
			replyError(w, http.StatusRequestTimeout, "vehicle_unavailable")
		case http.StatusPreconditionFailed:
			replyError(w, http.StatusPreconditionFailed, "virtual_key_unpaired")
		case http.StatusUnauthorized, http.StatusForbidden:
			replyError(w, recorder.Code, "permission")
		case http.StatusTooManyRequests:
			replyError(w, recorder.Code, "command_budget_replayed")
		default:
			replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		}
		return
	}
	var result struct {
		Response struct {
			Result *bool `json:"result"`
		} `json:"response"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil || result.Response.Result == nil || result.Error != "" {
		replyError(w, http.StatusBadGateway, "command_outcome_unknown")
		return
	}
	if !*result.Response.Result {
		replyError(w, http.StatusConflict, "command_rejected")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true})
}

// Candidate coordinate-route helpers remain in the existing function file: no new HTTP endpoint.
// Injection is available only to in-package Go tests; no HTTP/configuration can
// replace this runner. Its production default uses the pinned official SDK.
var gpsCandidateRunner = gpscandidate.RunBudgetedSignedCandidateObserved
var gpsDiagnosticRunner = func(ctx context.Context, store gpscandidate.RouteJournalStore, id, accountScope string, index int, payload []byte, acquire gpscandidate.Preflight, command nativewaypoints.Command, key protocol.ECDHPrivateKey, approval gpscandidate.TransportApproval, before func(context.Context) error) (gpscandidate.Summary, error) {
	factory := func(command nativewaypoints.Command, key protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
		return gpscandidate.NewBudgetedDiagnosticVehicle(ctx, command, key)
	}
	return gpscandidate.RunSignedDiagnosticPayload(ctx, store, id, accountScope, index, payload, acquire, factory, command, key, approval, before)
}

func gpsRoutePoints(args map[string]any) ([]gpscandidate.Point, bool) {
	if len(args) != 1 {
		return nil, false
	}
	raw, ok := args["points"].([]any)
	if !ok {
		return nil, false
	}
	points := make([]gpscandidate.Point, len(raw))
	for i, item := range raw {
		p, ok := item.(map[string]any)
		if !ok || len(p) != 2 {
			return nil, false
		}
		lat, a := p["lat"].(float64)
		lon, b := p["lon"].(float64)
		if !a || !b {
			return nil, false
		}
		points[i] = gpscandidate.Point{Latitude: lat, Longitude: lon}
	}
	if _, err := gpscandidate.EncodeRoute(points); err != nil {
		return nil, false
	}
	return points, true
}

func gpsRedisCommand(ctx context.Context, args ...string) (any, error) {
	endpoint, err := url.Parse(os.Getenv("TOKEN_STORE_REST_URL"))
	token := os.Getenv("TOKEN_STORE_REST_TOKEN")
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || token == "" {
		return nil, errors.New("store unavailable")
	}
	data, _ := json.Marshal(args)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("store unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return nil, errors.New("store unavailable")
	}
	defer response.Body.Close()
	var body struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 65537))
	if response.StatusCode != 200 || decoder.Decode(&body) != nil || decoder.Decode(new(any)) != io.EOF || body.Error != "" {
		return nil, errors.New("store unavailable")
	}
	if string(body.Result) == "null" {
		return nil, nil
	}
	var text string
	if json.Unmarshal(body.Result, &text) == nil {
		return text, nil
	}
	var number int64
	if json.Unmarshal(body.Result, &number) == nil {
		return number, nil
	}
	return nil, errors.New("invalid store response")
}

func gpsNavigationGuardKey(vin, actionScope string) string {
	sum := sha256.Sum256([]byte(vin))
	key := "tesla-voice:v1:gps-fixture-navigation:" + base64.RawURLEncoding.EncodeToString(sum[:])
	if actionScope == "" {
		return key + ":pending" // Read/write compatibility for an existing diagnostic session.
	}
	if !navigationScopePattern.MatchString(actionScope) {
		return ""
	}
	return key + ":" + actionScope + ":pending"
}

func gpsRouteJournalScope(vin, actionScope string) (string, error) {
	if !navigationScopePattern.MatchString(actionScope) {
		return "", errors.New("invalid navigation scope")
	}
	sum := sha256.Sum256([]byte("gps-route-candidate-v2\n" + vin + "\n" + actionScope))
	return hex.EncodeToString(sum[:]), nil
}

func serveGPSRoute(w http.ResponseWriter, r *http.Request, e commandEnvelope, key protocol.ECDHPrivateKey, forwarded *bool) {
	points, ok := gpsRoutePoints(e.Arguments)
	if !ok {
		replyError(w, 400, "invalid_command")
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), time.UnixMilli(e.RouteDeadlineMillis))
	defer cancel()
	scope, err := gpsRouteJournalScope(e.VIN, e.NavigationGuardScope)
	guardKey := gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope)
	if err != nil || guardKey == "" {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	store, err := gpscandidate.NewJournalStore(gpsRedisCommand, scope)
	if err != nil {
		replyError(w, 503, "command_upstream_unavailable")
		return
	}
	journal, err := gpscandidate.NewJournal(points)
	if err != nil {
		replyError(w, 400, "invalid_command")
		return
	}
	routeHash := sha256.Sum256([]byte(e.Nonce))
	journal.RouteID = hex.EncodeToString(routeHash[:16])
	journal.CommandNonce = e.Nonce
	if err = store.Create(ctx, journal); err != nil {
		replyError(w, 503, "command_upstream_unavailable")
		return
	}
	verifyGuard := func(ctx context.Context) error {
		value, err := gpsRedisCommand(ctx, "GET", guardKey)
		if err != nil || value != e.NavigationGuardOwner {
			return errors.New("navigation guard unavailable")
		}
		return nil
	}
	acquire := func(ctx context.Context, _ int) (func(), error) {
		if err := verifyGuard(ctx); err != nil {
			return nil, err
		}
		return func() {}, nil
	}
	// The existing global fleetBudgetTransport meters every SDK HTTP exchange.
	// The Node permanent guard must still be owned before each actuation attempt.
	beforeCommand := func(ctx context.Context) error {
		if err := verifyGuard(ctx); err != nil {
			return err
		}
		*forwarded = true
		return nil
	}
	summary, err := gpsCandidateRunner(ctx, store, journal.RouteID, points, acquire, nativewaypoints.Command{VIN: e.VIN, AccessToken: e.AccessToken}, key, gpscandidate.TransportApproval{Enabled: true, ExperimentalSchema: gpscandidate.ExperimentalOrderSchema}, beforeCommand)
	w.Header().Set("Content-Type", "application/json")
	if err != nil || !summary.AllAPIAccepted {
		code := "command_upstream_unavailable"
		status := 503
		if *forwarded {
			code = "command_outcome_unknown"
			status = 502
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": code, "route_reference": journal.RouteID, "route_summary": summary})
		return
	}
	// Retain all evidence. Release only an accepted journal's own scope guard.
	// Failure leaves the guard retained; a later Create can reconcile it safely.
	_, _ = store.ReconcileGuard(ctx)
	_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true, "completed": false, "navigation_mode": "experimental_gps_append", "route_reference": journal.RouteID, "route_summary": summary})
}

func serveGPSDiagnostic(w http.ResponseWriter, r *http.Request, e commandEnvelope, key protocol.ECDHPrivateKey, forwarded *bool) {
	point, ok := gpsDiagnosticPointFrom(e.Arguments)
	if !ok || !validGPSDiagnosticEnvelope(e) {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), time.UnixMilli(e.RouteDeadlineMillis))
	defer cancel()
	vehicleScope := sha256.Sum256([]byte("gps-diagnostic-vehicle-v1\n" + e.VIN))
	guardKey := gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope)
	if guardKey == "" {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	store, err := gpscandidate.NewDiagnosticJournalStore(gpsRedisCommand, hex.EncodeToString(vehicleScope[:]))
	if err != nil {
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	index := 0
	var payload []byte
	var journal gpscandidate.Journal
	if e.GPSDiagnostic.Phase == "replace" {
		appendPoint := gpscandidate.Point{Latitude: *e.GPSDiagnostic.ExpectedAppend.Lat, Longitude: *e.GPSDiagnostic.ExpectedAppend.Lon}
		journal, err = gpscandidate.NewDiagnosticJournal([]gpscandidate.Point{point, appendPoint}, e.GPSDiagnostic.SessionID, e.GPSDiagnostic.AccountScope, e.Nonce, time.Now().Add(15*time.Minute).UnixMilli())
		if err == nil {
			payload, err = gpscandidate.EncodeDiagnosticPoint(point, false)
		}
		if err == nil {
			err = store.Create(ctx, journal)
		}
		if err != nil {
			replyError(w, http.StatusConflict, "diagnostic_session_unavailable")
			return
		}
	} else {
		index = 1
		journal, err = store.Load(ctx, e.GPSDiagnostic.SessionID)
		if err != nil || journal.AccountScope != e.GPSDiagnostic.AccountScope || journal.ExpiresAtMS <= time.Now().UnixMilli() || len(journal.Steps) != 2 || journal.Steps[0].State != gpscandidate.Accepted || journal.Steps[1].State != gpscandidate.Pending {
			replyError(w, http.StatusConflict, "diagnostic_session_invalid")
			return
		}
		payload, err = gpscandidate.EncodeDiagnosticPoint(point, true)
		if err != nil {
			replyError(w, http.StatusBadRequest, "invalid_command")
			return
		}
	}
	verifyGuard := func(ctx context.Context) error {
		value, err := gpsRedisCommand(ctx, "GET", guardKey)
		if err != nil || value != e.NavigationGuardOwner {
			return errors.New("navigation guard unavailable")
		}
		return nil
	}
	acquire := func(ctx context.Context, _ int) (func(), error) {
		if err := verifyGuard(ctx); err != nil {
			return nil, err
		}
		return func() {}, nil
	}
	beforeCommand := func(ctx context.Context) error {
		if err := verifyGuard(ctx); err != nil {
			return err
		}
		*forwarded = true
		return nil
	}
	summary, err := gpsDiagnosticRunner(ctx, store, e.GPSDiagnostic.SessionID, e.GPSDiagnostic.AccountScope, index, payload, acquire, nativewaypoints.Command{VIN: e.VIN, AccessToken: e.AccessToken}, key, gpscandidate.TransportApproval{Enabled: true, ExperimentalSchema: gpscandidate.ExperimentalOrderSchema}, beforeCommand)
	if err != nil {
		journal, journalErr := store.Load(ctx, e.GPSDiagnostic.SessionID)
		if journalErr == nil && index < len(journal.Steps) && journal.Steps[index].State == gpscandidate.Rejected && *forwarded {
			replyError(w, http.StatusConflict, "command_rejected")
		} else if *forwarded {
			replyError(w, http.StatusBadGateway, "command_outcome_unknown")
		} else {
			replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		}
		return
	}
	if index == 1 {
		if summary.AcceptedSteps != 2 || !summary.AllAPIAccepted {
			replyError(w, http.StatusBadGateway, "command_outcome_unknown")
			return
		}
		// A completed API journal may release only its own retained guard. This
		// does not certify that either destination appeared on the display.
		_, _ = store.ReconcileGuard(ctx)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"accepted": true, "completed": false, "navigation_mode": "experimental_gps_diagnostic",
		"phase": e.GPSDiagnostic.Phase, "session_id": e.GPSDiagnostic.SessionID,
		"api_accepted": true, "accepted_stops": summary.AcceptedSteps,
		"total_stops": summary.TotalSteps, "vehicle_route_verified": false,
		"display_verified": false, "session_expires_at": time.UnixMilli(journal.ExpiresAtMS).UTC().Format(time.RFC3339),
	})
}

// Gated native candidates share the original signed envelope, nonce claim,
// global Fleet meter and immutable command receipts. No new HTTP endpoint.
func nativeCandidateMode(e commandEnvelope) string {
	if e.Operation == "navigation_sc_request" {
		return "experimental_native_supercharger"
	}
	if e.Operation == "navigation_waypoints_request" {
		if s, ok := e.Arguments["waypoints"].(string); ok && strings.Contains(s, ";") {
			return "experimental_native_coordinate_batch"
		}
		if s, ok := e.Arguments["waypoints"].(string); ok && nativewaypoints.Valid(s) {
			return "experimental_native_refid_waypoints"
		}
	}
	return ""
}
func nativeCandidateEnabled(mode string) bool {
	if os.Getenv("VERCEL_ENV") != "production" || !validPublicOrigin(os.Getenv("APP_ORIGIN")) || os.Getenv("TESLA_FLEET_REGION") != "eu" {
		return false
	}
	for _, name := range []string{"TESLA_BACKEND_ENABLED", "TESLA_READ_ENABLED", "TESLA_COMMANDS_ENABLED", "TESLA_COMMAND_EXECUTION_ENABLED", "TESLA_REAL_RELEASE_APPROVED"} {
		if os.Getenv(name) != "true" {
			return false
		}
	}
	if mode == "experimental_native_coordinate_batch" {
		return os.Getenv("TESLA_NATIVE_COORDINATE_PILOT_ENABLED") == "true" && os.Getenv("TESLA_NATIVE_COORDINATE_ENABLED") == "true" && os.Getenv("TESLA_NATIVE_COORDINATE_SCHEMA") == navigationcontracts.CoordinateBatchSchema
	}
	if mode == "experimental_native_supercharger" {
		return os.Getenv("TESLA_NATIVE_SUPERCHARGER_ENABLED") == "true" && os.Getenv("TESLA_NATIVE_SUPERCHARGER_SCHEMA") == navigationcontracts.SuperchargerSchema
	}
	return mode == "experimental_native_refid_waypoints" && os.Getenv("TESLA_NATIVE_WAYPOINTS_ENABLED") == "true"
}

var nativeCandidateFactory = func(ctx context.Context, command nativewaypoints.Command, key protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
	return gpscandidate.NewBudgetedSingleVehicle(ctx, command, key)
}

func serveNativeCandidate(w http.ResponseWriter, r *http.Request, e commandEnvelope, key protocol.ECDHPrivateKey, forwarded *bool, mode string) {
	guardKey := gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope)
	if guardKey == "" {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	var payload []byte
	var err error
	count := 1
	if mode == "experimental_native_coordinate_batch" {
		var points []navigationcontracts.Point
		points, err = navigationcontracts.ParseCoordinateString(e.Arguments["waypoints"].(string))
		if err == nil {
			count = len(points)
			payload, err = navigationcontracts.EncodeCoordinateBatchCandidate(points, navigationcontracts.CoordinateBatchSchema)
		}
	} else if mode == "experimental_native_refid_waypoints" {
		waypoints := e.Arguments["waypoints"].(string)
		count = len(strings.Split(waypoints, ","))
		payload, err = nativewaypoints.Payload(waypoints)
	} else {
		payload, err = navigationcontracts.EncodeSuperchargerCandidate(e.Arguments["site_id"].(string), navigationcontracts.SuperchargerSchema)
	}
	if err != nil {
		replyError(w, 400, "invalid_command")
		return
	}
	verify := func(ctx context.Context) error {
		value, err := gpsRedisCommand(ctx, "GET", guardKey)
		if err != nil || value != e.NavigationGuardOwner {
			return errors.New("native navigation guard unavailable")
		}
		return nil
	}
	before := func(ctx context.Context) error {
		if err := verify(ctx); err != nil {
			return err
		}
		*forwarded = true
		return nil
	}
	factory := func(command nativewaypoints.Command, key protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
		return nativeCandidateFactory(r.Context(), command, key)
	}
	err = navigationcontracts.RunSingle(r.Context(), payload, nativewaypoints.Command{VIN: e.VIN, AccessToken: e.AccessToken}, key, factory, verify, before)
	if err != nil {
		reason, status, fault := navigationcontracts.FailureDiagnostic(err)
		log.Printf("TESLA_NATIVE_CANDIDATE_FAILURE phase=%s reason=%s http_status=%d protocol_fault=%s dispatch_boundary_crossed=%t", navigationcontracts.FailurePhase(err), reason, status, fault, *forwarded)
		if errors.Is(err, navigationcontracts.ErrRejected) {
			replyError(w, 409, "command_rejected")
		} else if *forwarded {
			replyError(w, 502, "command_outcome_unknown")
		} else {
			replyError(w, 503, "command_upstream_unavailable")
		}
		return
	}
	result := map[string]any{"accepted": true, "completed": false, "navigation_mode": mode, "api_actuation_count": 1, "requested_destinations": count, "vehicle_route_verified": false, "battery_preconditioning_verified": false}
	if mode == "experimental_native_supercharger" {
		result["site_id"] = e.Arguments["site_id"]
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}
