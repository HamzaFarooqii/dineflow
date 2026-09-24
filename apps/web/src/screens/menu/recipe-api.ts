// Back-office recipe data — fetched live from the API, not cached in Dexie: recipes and unit
// costs are management data the register never needs offline.
import { accessToken, configuredApiUrl } from '../../lib/catalog'
import type { RecipeIngredientOption, RecipePayload, RecipeUnit, SavedRecipe, UnitKind } from './recipe-draft'

export interface RecipeData {
  ingredientsReady: boolean
  units: RecipeUnit[]
  ingredients: RecipeIngredientOption[]
  recipes: SavedRecipe[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${configuredApiUrl()}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
  })
  const data = await response.json().catch(() => null) as ({ message?: string } & T) | null
  if (!response.ok || !data) throw new Error(data?.message ?? `Server error (${response.status})`)
  return data
}

export async function loadRecipeData(storeId: string): Promise<RecipeData> {
  const data = await request<{ ingredients_ready: boolean; units: RecipeUnit[]; ingredients: RecipeIngredientOption[]; recipes: SavedRecipe[] }>(
    `/catalog/recipes?store_id=${encodeURIComponent(storeId)}`,
  )
  return { ingredientsReady: data.ingredients_ready, units: data.units, ingredients: data.ingredients, recipes: data.recipes }
}

export async function saveRecipe(storeId: string, productId: string, payload: RecipePayload): Promise<SavedRecipe> {
  const data = await request<{ recipe: SavedRecipe }>(`/catalog/products/${encodeURIComponent(productId)}/recipe`, {
    method: 'PUT',
    body: JSON.stringify({ store_id: storeId, ...payload }),
  })
  return data.recipe
}

export async function createUnit(storeId: string, unit: { name: string; abbreviation: string; kind: UnitKind }): Promise<RecipeUnit> {
  const data = await request<{ unit: RecipeUnit }>('/catalog/units', { method: 'POST', body: JSON.stringify({ store_id: storeId, ...unit }) })
  return data.unit
}
