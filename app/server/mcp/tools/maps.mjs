import { ToolError, errorResult, jsonResult } from "../lib/core.mjs"
import { geocode, mapHtml, nearby, reverseGeocode, route, timezoneInfo, weather } from "../lib/maps.mjs"

export const mapsTool = {
  register(server, { z }) {
    server.registerTool(
      "maps",
      {
        title: "Maps, routes, places and weather",
        description:
          "Geocode addresses, reverse-geocode coordinates, plan routes with turn-by-turn steps, calculate distance, find nearby places, get current/daily weather, convert time zones, and generate an interactive OpenStreetMap HTML map. Use this automatically for location, travel, weather or map requests.",
        inputSchema: {
          action: z.enum(["geocode", "reverse", "route", "distance", "nearby", "weather", "timezone", "map"]),
          query: z.string().optional(),
          lat: z.number().optional(),
          lon: z.number().optional(),
          points: z.any().optional().describe("Array of {lat,lon} or [lon,lat]."),
          profile: z.enum(["driving", "walking", "cycling"]).optional(),
          category: z.string().optional().describe("Nearby category (restaurant, cafe, hospital, ...)."),
          radius: z.number().optional(),
          days: z.number().int().positive().optional(),
          timezone: z.string().optional(),
          date: z.string().optional(),
          title: z.string().optional(),
          zoom: z.number().optional(),
          output: z.string().optional(),
          limit: z.number().int().positive().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          if (args.action === "geocode") return jsonResult(await geocode(args.query, { limit: args.limit }))
          if (args.action === "reverse") return jsonResult(await reverseGeocode(args.lat, args.lon))
          if (args.action === "route") return jsonResult(await route(args))
          if (args.action === "distance") {
            const result = await route({ ...args, profile: args.profile })
            return jsonResult({ distanceMeters: result.distanceMeters, durationSeconds: result.durationSeconds })
          }
          if (args.action === "nearby") return jsonResult(await nearby(args))
          if (args.action === "weather") return jsonResult(await weather(args))
          if (args.action === "timezone") return jsonResult(timezoneInfo(args))
          if (args.action === "map") return jsonResult(await mapHtml(args))
          throw new ToolError(`unknown maps action: ${args.action}`, "BAD_INPUT")
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
