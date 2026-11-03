import cleanup from '@salesforce/apex/AccountService.cleanup';
import EMAIL from '@salesforce/schema/Customer__c.Email__c';
import GREETING from '@salesforce/label/c.HelloLabel';
import logoUrl from '@salesforce/resourceUrl/CompanyLogo';
import { useFetch } from '@/hooks/useFetch';
import { Card } from '../components/Card';

export default function HomePage() {
  const data = useFetch();
  return (
    <div>
      <Card title={GREETING} />
      <img src={logoUrl} alt="logo" />
      <button onClick={() => cleanup()}>Clean</button>
      <p>{EMAIL}: {data}</p>
    </div>
  );
}
