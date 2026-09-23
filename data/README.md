# Wind data sources

## OpenStreetMap China turbines

`cn_osm_turbines.json` contains 157,934 turbine nodes mapped to the unified
`WindTurbine` view. Fields are `lat`, `lon`, `name`, `cap_kw`, `manu`,
`hh_m`, `rd_m`, and `src`. The API lazily loads the file and indexes points in
one-degree geographic buckets; viewport requests are capped and grid-aggregated.

Source: <https://www.openstreetmap.org/>  
License: Open Data Commons Open Database License (ODbL).  
Attribution: © OpenStreetMap contributors.

## WRI Global Power Plant Database

`gppd_v1.1.0.csv` is the complete Global Power Plant Database. The unified
`/api/wind/farms` view filters `fuel1=Wind` and `country=CHN`, producing 835
China wind farms mapped to `WindFarm`.

Source: <https://datasets.wri.org/dataset/globalpowerplantdatabase>  
License: Creative Commons Attribution 4.0 International (CC-BY 4.0).

## USWTDB selections

`uswind_picks.json` contains five turbine-level selections derived from the U.S. Wind Turbine Database (USWTDB) v9.0, release date 2026-06-26. Records are limited to `t_conf_loc = 3` (satellite-image location confidence). The same pipeline aggregates these records into five USGS `WindFarm` records and exposes their exact turbine points.

Source: <https://energy.usgs.gov/uswtdb/>

API and metadata: <https://eerscmap.usgs.gov/uswtdb/api-doc/>

The U.S. Wind Turbine Database is maintained by the U.S. Geological Survey in partnership with the U.S. Department of Energy and Lawrence Berkeley National Laboratory. Unless stated otherwise in the source metadata, USWTDB data are in the public domain as a work of the United States Government. No endorsement by USGS is implied.
