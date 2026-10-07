-- Describe the hex area around (centerX, centerY) as playerID's team knows it.
-- Unrevealed plots are only counted. Resources respect the team's tech reveal,
-- improvements/owners use the team's revealed state, and units are listed only on
-- plots the team currently sees (invisible units such as submarines are skipped).
local pPlayer = Players[playerID]
if not pPlayer then return nil end
local iTeam = pPlayer:GetTeam()

-- Localized name for a GameInfo row id, or nil for "none"
local function infoName(info, id)
  if id == nil or id < 0 then return nil end
  local row = info[id]
  if not row then return nil end
  return Locale.ConvertTextKey(row.Description)
end

-- Display name for a player id as other players would see it
local function playerName(iOwner)
  if iOwner == nil or iOwner < 0 then return nil end
  local pOwner = Players[iOwner]
  if not pOwner then return nil end
  if pOwner:IsBarbarian() then return "Barbarians" end
  if pOwner:IsMinorCiv() then return "City-State " .. pOwner:GetName() end
  return pOwner:GetCivilizationShortDescription()
end

local tiles = {}
local unrevealed = 0

for dx = -radius, radius do
  for dy = -radius, radius do
    local pPlot = Map.PlotXYWithRangeCheck(centerX, centerY, dx, dy, radius)
    if pPlot then
      if not pPlot:IsRevealed(iTeam, false) then
        unrevealed = unrevealed + 1
      else
        local iX, iY = pPlot:GetX(), pPlot:GetY()
        local tile = {
          X = iX,
          Y = iY,
          Distance = Map.PlotDistance(centerX, centerY, iX, iY),
          Terrain = infoName(GameInfo.Terrains, pPlot:GetTerrainType()),
          Feature = infoName(GameInfo.Features, pPlot:GetFeatureType()),
          Improvement = infoName(GameInfo.Improvements, pPlot:GetRevealedImprovementType(iTeam, false)),
          Route = infoName(GameInfo.Routes, pPlot:GetRevealedRouteType(iTeam, false)),
          Owner = playerName(pPlot:GetRevealedOwner(iTeam, false)),
          Visible = pPlot:IsVisible(iTeam, false)
        }
        if pPlot:IsMountain() then tile.Elevation = "Mountain"
        elseif pPlot:IsHills() then tile.Elevation = "Hills" end
        if pPlot:IsRiver() then tile.River = true end
        if pPlot:IsLake() then tile.Lake = true end
        if pPlot:IsImpassable(iTeam) then tile.Impassable = true end

        local iResource = pPlot:GetResourceType(iTeam)
        if iResource >= 0 then
          tile.Resource = infoName(GameInfo.Resources, iResource)
          local iAmount = pPlot:GetNumResource()
          if iAmount > 1 then tile.ResourceAmount = iAmount end
        end

        if pPlot:IsCity() and tile.Owner then
          local pCity = pPlot:GetPlotCity()
          if pCity then tile.City = pCity:GetName() end
        end

        -- Units only where the team has vision right now
        if tile.Visible then
          local units = {}
          for i = 0, pPlot:GetNumUnits() - 1 do
            local pUnit = pPlot:GetUnit(i)
            if pUnit and not pUnit:IsInvisible(iTeam, false) then
              local label = (playerName(pUnit:GetOwner()) or "Unknown") .. " " .. (infoName(GameInfo.Units, pUnit:GetUnitType()) or "Unit")
              units[label] = (units[label] or 0) + 1
            end
          end
          if next(units) then tile.Units = units end
        end

        tiles[#tiles + 1] = tile
      end
    end
  end
end

return { Tiles = tiles, Unrevealed = unrevealed }
