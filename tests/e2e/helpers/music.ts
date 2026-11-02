import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export async function reviewOption(page: Page, name: string) {
  if(name!=='Очистить локальные демо-данные')await expect(page.getByRole('region',{name:'Разбор плейлиста',exact:true})).toBeVisible()
  const button=page.getByRole('button',{name,exact:true})
  if(!await button.isVisible()){
    const reviewMenu=page.getByLabel('Ещё действия',{exact:true})
    if(await reviewMenu.count())await reviewMenu.click()
    else await page.getByText('Меню',{exact:true}).click()
  }
  await button.click()
}
