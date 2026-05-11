import pandas as pd
import matplotlib.pyplot as plt
import numpy as np

# Configuration des fichiers
files = {
    'Moteur 1 (XY-G)': 'annexes/res_M1.csv',
    'Moteur 2 (XY-D)': 'annexes/res_M2.csv'
}

def analyser_vibrations(file_dict):
    plt.figure(figsize=(14, 8))
    
    colors = ['#c65050', '#0056b3'] # Rouge pour M1, Bleu pour M2
    width = 2.0  
    results = {}

    for i, (label, path) in enumerate(file_dict.items()):
        try:
            # Chargement des données
            df = pd.read_csv(path)
            # Calcul de l'accélération nette (écart à la gravité)
            df['Net'] = np.abs(df['Magnitude'] - 9.81)
            
            # --- IDENTIFICATION DU MINIMUM ---
            idx_min = df['Net'].idxmin()
            min_rpm = df.loc[idx_min, 'RPM']
            min_val = df.loc[idx_min, 'Net']
            results[label] = (min_rpm, min_val)
            
            # Tracé de l'histogramme
            offset = -width/2 if i == 0 else width/2
            plt.bar(df['RPM'] + offset, df['Net'], 
                    width=width, label=label, color=colors[i], 
                    alpha=0.6, edgecolor='black', linewidth=0.5)
            
            # --- MARQUAGE SUR LE GRAPHIQUE ---
            # Point jaune pour le minimum
            plt.scatter(min_rpm + offset, min_val, color='yellow', edgecolor='black', 
                        s=120, zorder=5, label=f"Point stable {label}")
            
            # Bulle d'annotation
            plt.annotate(f"Min: {min_val:.2f} m/s²\nà {min_rpm} RPM", 
                         xy=(min_rpm + offset, min_val),
                         xytext=(0, 15), textcoords='offset points',
                         ha='center', fontsize=10, fontweight='bold',
                         bbox=dict(boxstyle='round,pad=0.3', fc='white', ec=colors[i], alpha=0.9))

        except Exception as e:
            print(f"Erreur sur {path}: {e}")

    # --- AFFICHAGE CONSOLE ---
    print("\n" + "="*40)
    print(" SYNTHÈSE DES MINIMUMS D'ACCÉLÉRATION")
    print("="*40)
    for motor, (rpm, val) in results.items():
        print(f"-> {motor} : {val:.4f} m/s² à {rpm} RPM")
    print("="*40)

    # Mise en forme du graphique
    plt.title("Analyse des Minimums Vibratoires pour le choix de Vmin", fontsize=14, fontweight='bold')
    plt.xlabel("Vitesse de rotation (RPM)", fontweight='bold')
    plt.ylabel("Accélération Nette |a - g| (m/s²)", fontweight='bold')
    
    # Zone critique 10-100 RPM
    plt.axvspan(10, 100, color='red', alpha=0.05, label='Zone de résonance critique')
    
    plt.grid(axis='y', linestyle=':', alpha=0.6)
    plt.legend(loc='upper left', bbox_to_anchor=(1, 1))
    plt.tight_layout()
    
    plt.savefig('analyse_minimums_vibration.png')
    plt.show()

if __name__ == "__main__":
    analyser_vibrations(files)