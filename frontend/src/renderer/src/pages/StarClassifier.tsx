import type { ReactElement } from 'react'
import { StarClassifierTab } from '@renderer/components/starclassifier/StarClassifierTab'

export function StarClassifier(): ReactElement {
  return (
    <div className="h-full">
      <StarClassifierTab />
    </div>
  )
}
