# Real vehicle testing — developer-reported record

The developer confirms that all 75 catalog operations were tested successfully on their own Tesla Model 3 in October 2026, and that multipoint navigation with up to 16 destinations worked on the vehicle. The project was used operationally by the developer. These are developer-reported results, not an independent audit.

| Field | Recorded information |
| --- | --- |
| Vehicle | Tesla Model 3 |
| Test period | October 2026 |
| Methods | Offline synthetic tests and online interactions with the real vehicle |
| Operations | All 75 operations listed below, reported successfully tested by the developer |
| Multipoint navigation | Up to 16 destinations, reported successfully tested by the developer |
| Firmware | Not recorded |
| Project revision and transport configuration | Not recorded |
| Per-operation dates, parameters and results | Not recorded |
| Independent audit | Not performed |

## Historical testing and current availability

The catalog field `vehicle_test_status: developer_reported_tested` records the developer's historical statement for each operation. It does not establish which revision or transport was used, independent verification, or compatibility with another vehicle. The separate `transport_supported` field describes availability under the current configuration. Eight transports are unavailable by default in the pinned SDK/proxy; some navigation paths have separately gated experimental alternatives. The configuration used to test those eight operations is not recorded. No conclusion about an individual command's availability should be drawn from the historical test status.

## Operations covered by the developer's statement

The following is the current 75-name source catalog grouped by category. The statement applies to the complete set; no individual dates, firmware, parameters or technical evidence are implied.

### security

- `clear_pin_to_drive_admin`
- `reset_pin_to_drive_pin`
- `reset_valet_pin`
- `parental_controls_activate`
- `parental_controls_clear_pin_admin`
- `parental_controls_deactivate`
- `parental_controls_enable_setting`
- `parental_controls_set_speed_limit`
- `set_pin_to_drive`
- `set_valet_mode`
- `speed_limit_activate`
- `speed_limit_deactivate`
- `speed_limit_clear_pin`
- `speed_limit_clear_pin_admin`
- `erase_user_data`
- `set_sentry_mode`
- `guest_mode`
- `remote_start_drive`
- `speed_limit_set_limit`

### navigation

- `navigation_gps_request` — unavailable by default in the pinned proxy
- `navigation_sc_request` — unavailable by default in the pinned proxy
- `navigation_waypoints_request` — unavailable by default in the pinned proxy
- `navigation_request`

### vehicle

- `sun_roof_control` — unavailable by default in the pinned proxy
- `upcoming_calendar_entries` — unavailable by default in the pinned proxy
- `set_low_power_mode`
- `keep_accessory_power_mode`
- `wake_up`
- `set_vehicle_name`

### charging

- `charge_start`
- `charge_stop`
- `charge_standard`
- `charge_max_range`
- `set_charge_limit`
- `set_charging_amps`
- `set_scheduled_charging`
- `set_scheduled_departure`
- `add_charge_schedule`
- `remove_charge_schedule`
- `charge_port_door_open`
- `charge_port_door_close`

### climate

- `add_precondition_schedule`
- `remove_precondition_schedule`
- `auto_conditioning_start`
- `auto_conditioning_stop`
- `set_temps`
- `remote_seat_heater_request`
- `remote_seat_cooler_request`
- `remote_auto_seat_climate_request`
- `remote_steering_wheel_heater_request`
- `remote_auto_steering_wheel_heat_climate_request` — unavailable by default in the pinned proxy
- `remote_steering_wheel_heat_level_request` — unavailable by default in the pinned proxy
- `set_bioweapon_mode`
- `set_preconditioning_max`
- `set_climate_keeper_mode`
- `set_cop_temp`
- `set_cabin_overheat_protection`

### access

- `door_lock`
- `door_unlock`
- `trigger_homelink`
- `window_control`
- `actuate_trunk`

### signals

- `flash_lights`
- `honk_horn`
- `remote_boombox` — unavailable by default in the pinned proxy

### media

- `media_toggle_playback`
- `media_next_track`
- `media_prev_track`
- `adjust_volume`
- `media_volume_up`
- `media_volume_down`
- `media_next_fav`
- `media_prev_fav`

### software

- `schedule_software_update`
- `cancel_software_update`

See [Evidence](EVIDENCE.md), [Features](FEATURES.md) and [Tool reference](TOOLS_REFERENCE.md) for evidence levels, execution gates and present-day limitations.
