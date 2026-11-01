import type { Page } from '@playwright/test'

export async function reviewOption(page: Page, name: string) {
  const button=page.getByRole('button',{name,exact:true})
  if(!await button.isVisible())await page.getByLabel('Ещё действия',{exact:true}).click()
  await button.click()
}
